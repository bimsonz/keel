// The Lane's use-cases over in-memory ports: one batch of one in flight, in
// FIFO order, decided by the domain's Candidate machine. Deliveries are
// handed to `laneHeard` as the Lane DO's receive would; each step runs
// `laneStep` as the `lane step` alarm would.
import { describe, expect, it } from "@effect/vitest";
import {
  batchOf,
  bundleBlame,
  laneHeard,
  laneOf,
  laneStep,
  projectRepos,
  recordVerdict,
  reofferDue,
  reofferVerified,
} from "@keeltown/core/application/integration";
import { L1_SUITE_PLAN } from "@keeltown/core/application/verification";
import type { Change } from "@keeltown/core/domain/coordination";
import type { VerdictOutcome } from "@keeltown/core/domain/verification";
import {
  type BatchId,
  type CandidateId,
  type ChangeId,
  CommitSha,
  type EntityRef,
  EventEnvelope,
  Instant,
  makeId,
} from "@keeltown/core/kernel";
import {
  type BatchVerdict,
  BatchVerification,
  BundleRefused,
  CandidateBundles,
  CandidateComposer,
  Changes,
  CodeHost,
  EntityStore,
  EventOutbox,
  StagingWriter,
} from "@keeltown/core/ports";
import { PushRejected } from "@keeltown/core/domain/integration";
import {
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeManualClock,
  makeProjectsMemory,
  makeStagingWriterMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import { ulid } from "ulid";

const PROJECT = makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const LANE = `lane:${PROJECT}:main`;
const STAGING = projectRepos(PROJECT).staging;
const MAIN = "refs/heads/main";
const AGENT = makeId("agt", "01J9AAAAAAAAAAAAAAAAAAAAAA");
const FAR = Instant(9_999_999_999_999);
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const change = (n: number): ChangeId => makeId("chg", `01J9C${String(n).padStart(21, "0")}`);
const changeRef = (id: ChangeId): EntityRef => ({ kind: "change", id });

interface WorldOptions {
  readonly refuseCompose?: readonly ChangeId[];
  readonly bundles?: Layer.Layer<CandidateBundles>;
  readonly verification?: "required" | "off";
  readonly composer?: (inner: Layer.Layer<CandidateComposer>) => Layer.Layer<CandidateComposer>;
  /** Staging's main refuses every move, as a staging some other writer holds would. */
  readonly stagingStuck?: boolean;
}

/** The Lane's ports in memory, staging's main shared by the code host and the StagingWriter. */
function world(options: WorldOptions = {}) {
  const code = makeCodeHostMemory();
  const clock = makeManualClock();
  const outbox = makeEventOutboxMemory();
  const verification = makeBatchVerificationMemory();
  const bundles = makeCandidateBundlesMemory();
  const stagingRepo = () => code.repos.get(`${STAGING.namespace}/${STAGING.name}`);
  const staging = makeStagingWriterMemory({
    get: () => stagingRepo()?.refs.get(MAIN),
    set: (to) => void stagingRepo()?.refs.set(MAIN, to),
  });
  const projects = makeProjectsMemory();
  projects.setSettings(PROJECT, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: options.verification ?? "required",
    visibility: "private",
  });
  const changes = new Map<ChangeId, Change>();
  const changesLayer = Layer.succeed(
    Changes,
    Changes.of({
      get: (id) =>
        Effect.suspend(() => {
          const found = changes.get(id);
          return found === undefined ? Effect.die(new Error(`no ${id}`)) : Effect.succeed(found);
        }),
      workspace: (id) =>
        Effect.succeed({
          workspaceId: makeId("wsp", ulid()),
          repo: { namespace: "memory", name: `ws-${id}` },
          baseSha: sha("0"),
          projectId: PROJECT,
        }),
      declare: () => Effect.die(new Error("the Lane never declares")),
      submit: () => Effect.die(new Error("the Lane never submits")),
      awaitSubmission: () => Effect.die(new Error("the Lane never waits on a submission")),
    }),
  );
  // What the batch's state is when KeelVerify is started: it must already be Verifying.
  const startedIn: string[] = [];
  const recordingVerification = Layer.effect(
    BatchVerification,
    Effect.gen(function* () {
      const inner = yield* BatchVerification;
      const store = yield* EntityStore;
      return BatchVerification.of({
        start: (instanceId, job) =>
          Effect.suspend(() => {
            startedIn.push(batchOf(store, job.fence.batchId)?.state ?? "none");
            return inner.start(instanceId, job);
          }),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(verification.layer, outbox.layer)));
  const composer = makeCandidateComposerMemory({ refuse: options.refuseCompose ?? [] }).layer;
  const layer = Layer.mergeAll(
    outbox.layer,
    clock.layer,
    makeIdsMemory().layer,
    code.layer,
    options.composer?.(composer) ?? composer,
    options.bundles ?? bundles.layer,
    recordingVerification,
    options.stagingStuck === true
      ? Layer.succeed(
          StagingWriter,
          StagingWriter.of({
            fastForward: () => Effect.fail(new PushRejected({ reason: "stale" })),
          }),
        )
      : staging.layer,
    projects.layer,
    changesLayer,
  );
  const seeded = Effect.gen(function* () {
    (yield* EventOutbox).subscribe("projector", "*");
    yield* (yield* CodeHost).create(STAGING);
    return yield* code.fixture.commit(STAGING, MAIN, { "README.md": "keel\n" });
  });
  return { code, clock, verification, bundles, staging, changes, startedIn, layer, seeded };
}
type World = ReturnType<typeof world>;

let delivered = 0;
/** An event as another object committed it, addressed to the lane. */
const envelope = (
  entity: EntityRef,
  payload: { readonly _tag: string; readonly [k: string]: unknown },
) => {
  delivered += 1;
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_${ulid()}`,
    type: payload._tag,
    entity,
    seq: delivered,
    at: 0,
    dedupeKey: `${entity.kind}:${entity.id}/test-${delivered}/${payload._tag}#1`,
    affected: [],
    notified: [LANE],
    payload,
  });
};

/** Delivers one event to the lane as the Lane DO's receive does: recorded and reacted to in one transaction. */
const deliver = (event: EventEnvelope) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    const at = Instant(0);
    return store.transaction(
      () => outbox.receive(event.dedupeKey, at) && laneHeard({ store, outbox, at }, LANE, event),
    );
  });

const queue = (w: World, id: ChangeId) =>
  Effect.gen(function* () {
    w.changes.set(id, {
      id,
      agentId: AGENT,
      origin: "agent",
      state: "queued",
      intent: { revision: 1, goal: `goal of ${id}`, footprint: [], premises: [] },
      lease: { id: makeId("lse", ulid()), agentId: AGENT, renewedAt: Instant(0), state: "active" },
      createdAt: Instant(0),
      baseSha: sha("0"),
      commitSha: sha("c"),
      laneId: LANE,
    });
    return yield* deliver(
      envelope(changeRef(id), { _tag: "ChangeQueued", changeId: id, laneId: LANE }),
    );
  });

const requeue = (id: ChangeId, batchId: BatchId) =>
  deliver(
    envelope(changeRef(id), {
      _tag: "ChangeRequeued",
      changeId: id,
      batchId,
      reason: "infra-failure",
    }),
  );

const advance = (from: string, to: string, members: readonly ChangeId[]) =>
  deliver(
    envelope(
      { kind: "trunk", id: PROJECT },
      {
        _tag: "TrunkAdvanced",
        projectId: PROJECT,
        from,
        to,
        groupId: "grp-1",
        landings: members.map((changeId) => ({
          changeId,
          commitSha: to,
          candidateId: makeId("cnd", "01J9KKKKKKKKKKKKKKKKKKKKKK"),
          proofId: `proof-${changeId}`,
        })),
      },
    ),
  );

/** The batch in flight, as the lane holds it. */
const inFlight = Effect.gen(function* () {
  const active = laneOf(yield* EntityStore, LANE)?.active;
  if (active === undefined) return yield* Effect.die(new Error("no batch in flight"));
  return active;
});

/** Every event the lane committed, in commit order, as the Projector hears them. */
const committed = Effect.map(
  EventOutbox,
  (outbox) => outbox.due(FAR, 1_000).find((d) => d.subscriber === "projector")?.events ?? [],
);
const heardBy = (subscriber: string) =>
  Effect.map(
    EventOutbox,
    (outbox) => outbox.due(FAR, 1_000).find((d) => d.subscriber === subscriber)?.events ?? [],
  );
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const payloads = (type: string) =>
  Effect.map(committed, (events) =>
    events.filter((e) => e.type === type).flatMap((e) => (isRecord(e.payload) ? [e.payload] : [])),
  );
/** The batch an event is about: its own entity, or a verdict's subject. */
const batchOfEvent = (e: EventEnvelope) =>
  e.entity.kind === "batch" ? e.entity.id : isRecord(e.payload) ? e.payload["subject"] : undefined;

const verdict = (
  batchId: BatchId,
  candidateId: CandidateId,
  instanceId: string,
  outcome: VerdictOutcome,
  attempt = 0,
): BatchVerdict => ({
  instanceId,
  fence: { batchId, attempt, chainEpoch: 0 },
  candidateId,
  verdictId: makeId("vrd", ulid()),
  outcome,
  planHash: L1_SUITE_PLAN.planHash,
  evidence: [`${outcome}: the suite said so`],
  failingTests: outcome === "bounce" ? ["suite > a test"] : [],
});

/** Runs the batch in flight to Verifying and answers it, its candidate and its KeelVerify instance. */
const toVerifying = (w: World) =>
  Effect.gen(function* () {
    expect(yield* laneStep(LANE)).toBe("waiting");
    const active = yield* inFlight;
    const instanceId = [...w.verification.started.keys()].at(-1);
    if (instanceId === undefined) return yield* Effect.die(new Error("KeelVerify never started"));
    return { batchId: active.batchId, candidateId: active.candidateId, instanceId };
  });

describe("the Lane", () => {
  it.effect(
    "[lane.fifo] batches the first queued change first, and the next only once it is done",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        const first = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "land"),
        );
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect((yield* payloads("BatchFormed")).map((p) => p["members"])).toEqual([[change(1)]]);
        yield* advance(base, sha("d"), [change(1)]);
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect((yield* payloads("BatchFormed")).map((p) => p["members"])).toEqual([
          [change(1)],
          [change(2)],
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.change-ends] a change withdrawn or superseded while queued is never batched",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        yield* queue(w, change(3));
        yield* deliver(
          envelope(changeRef(change(1)), {
            _tag: "ChangeWithdrawn",
            changeId: change(1),
            by: "agent",
          }),
        );
        yield* deliver(
          envelope(changeRef(change(2)), {
            _tag: "ChangeSuperseded",
            changeId: change(2),
            by: change(3),
          }),
        );
        yield* laneStep(LANE);
        expect((yield* payloads("BatchFormed")).map((p) => p["members"])).toEqual([[change(3)]]);
        expect(laneOf(yield* EntityStore, LANE)?.queue).toEqual([]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.form-base] forms the batch on staging main's head, not the member's base",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        yield* laneStep(LANE);
        const [formed] = yield* payloads("BatchFormed");
        expect(formed).toMatchObject({
          base,
          laneId: LANE,
          projectId: PROJECT,
          attempt: 0,
          chainEpoch: 0,
        });
        expect(base).not.toBe(sha("0"));
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.compose-deterministic] a compose retried later is asked for the same commits: BatchFormed's time, not the clock's",
    () => {
      const requests: { readonly at: number }[] = [];
      let failures = 1;
      const w = world({
        composer: (inner) =>
          Layer.effect(
            CandidateComposer,
            Effect.map(CandidateComposer, (composer) =>
              CandidateComposer.of({
                compose: (request) => {
                  requests.push(request);
                  if (failures-- > 0) return Effect.die(new Error("the binding dropped the read"));
                  return composer.compose(request);
                },
              }),
            ),
          ).pipe(Layer.provide(inner)),
      });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        expect(Exit.isFailure(yield* Effect.exit(laneStep(LANE)))).toBe(true);
        w.clock.advance(5_000);
        expect(yield* laneStep(LANE)).toBe("waiting");
        const formed = (yield* committed).find((e) => e.type === "BatchFormed");
        expect(requests.map((r) => r.at)).toEqual([formed?.at, formed?.at]);
        expect(w.clock.now()).not.toBe(formed?.at);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.verify-start] commits VerificationStarted, then starts KeelVerify once, named by BatchFormed, under L1's plan",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, candidateId, instanceId } = yield* toVerifying(w);
        const formed = (yield* committed).find((e) => e.type === "BatchFormed");
        expect(instanceId).toBe(`keel-verify-${formed?.eventId}`);
        expect(w.verification.started.get(instanceId)).toMatchObject({
          laneId: LANE,
          candidateId,
          fence: { batchId, attempt: 0, chainEpoch: 0 },
          planHash: L1_SUITE_PLAN.planHash,
          bundle: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        expect(w.startedIn).toEqual(["verifying"]);
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect(w.verification.started.size).toBe(1);
        expect((yield* committed).map((e) => e.type)).toEqual([
          "BatchFormed",
          "CandidateAssembled",
          "VerificationStarted",
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.verdict-fenced] a verdict for another attempt is ResultFenced and writes nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, candidateId, instanceId } = yield* toVerifying(w);
        const stale = yield* Effect.flip(
          recordVerdict(LANE, verdict(batchId, candidateId, `${instanceId}-old`, "land", 1)),
        );
        expect(stale).toMatchObject({ _tag: "ResultFenced", batchId, attempt: 1 });
        expect(batchOf(yield* EntityStore, batchId)?.state).toBe("verifying");
        expect((yield* committed).map((e) => e.type)).not.toContain("VerdictIssued");
        yield* recordVerdict(LANE, verdict(batchId, candidateId, instanceId, "land"));
        expect(batchOf(yield* EntityStore, batchId)?.state).toBe("green");
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.verdict-replay] the same KeelVerify instance reporting twice commits once",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, candidateId, instanceId } = yield* toVerifying(w);
        const landed = verdict(batchId, candidateId, instanceId, "land");
        yield* recordVerdict(LANE, landed);
        w.clock.advance(1_000);
        yield* recordVerdict(LANE, landed);
        const types = (yield* committed).map((e) => e.type);
        expect(types.filter((t) => t === "VerdictIssued")).toHaveLength(1);
        expect(types.filter((t) => t === "BatchVerified")).toHaveLength(1);
        expect(yield* heardBy(`trunk:${PROJECT}`)).toHaveLength(1);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.verdict-order] a bounce is the member's and a park the infrastructure's, each verdict reaching the member before its BatchFailed",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        const first = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "bounce"),
        );
        expect((yield* heardBy(`change:${change(1)}`)).map((e) => e.type)).toEqual([
          "BatchFormed",
          "VerdictIssued",
          "BatchFailed",
        ]);
        const [bounced] = yield* payloads("BatchFailed");
        expect(bounced).toMatchObject({ batchId: first.batchId, attribution: change(1) });
        yield* advance(base, base, []);
        yield* queue(w, change(2));
        const second = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(second.batchId, second.candidateId, second.instanceId, "park"),
        );
        const failed = yield* payloads("BatchFailed");
        expect(failed[1]).toMatchObject({ batchId: second.batchId, attribution: "infra" });
        const issued = yield* payloads("VerdictIssued");
        expect(issued.map((p) => p["outcome"])).toEqual(["bounce", "park"]);
        const order = (yield* committed).map((e) => e.type).filter((t) => t !== "BatchFormed");
        expect(order.slice(-2)).toEqual(["VerdictIssued", "BatchFailed"]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.composition-refused] a refused composition bounces its change with the reason and a remedy, and never bundles or verifies",
    () => {
      const w = world({ refuseCompose: [change(1)] });
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        expect(yield* laneStep(LANE)).toBe("idle");
        expect((yield* heardBy(`change:${change(1)}`)).map((e) => e.type)).toEqual([
          "BatchFormed",
          "VerdictIssued",
          "BatchFailed",
        ]);
        const [issued] = yield* payloads("VerdictIssued");
        expect(issued).toMatchObject({
          outcome: "bounce",
          evidence: ["composition-refused: both-modified"],
          nextActions: [
            {
              kind: "call",
              operationId: "revise",
              args: { changeId: change(1) },
              title: expect.stringContaining(base),
            },
          ],
        });
        expect((yield* payloads("BatchFailed"))[0]).toMatchObject({ attribution: change(1) });
        expect(w.bundles.bundled).toEqual([]);
        expect(w.verification.started.size).toBe(0);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.subscriptions] each member hears only its own batches, and the Trunk hears BatchVerified",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        const first = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "bounce"),
        );
        const second = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(second.batchId, second.candidateId, second.instanceId, "land"),
        );
        expect((yield* heardBy(`change:${change(1)}`)).map(batchOfEvent)).toEqual([
          first.batchId,
          first.batchId,
          first.batchId,
        ]);
        expect((yield* heardBy(`change:${change(2)}`)).map((e) => e.type)).toEqual([
          "BatchFormed",
          "VerdictIssued",
        ]);
        expect((yield* heardBy(`trunk:${PROJECT}`)).map((e) => [e.type, e.entity.id])).toEqual([
          ["BatchVerified", second.batchId],
        ]);
        expect(base).toBeDefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.verdict-next-actions] a bounce carries KeelVerify's own remedy onto the change's VerdictIssued",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const first = yield* toVerifying(w);
        const remedy = [
          { kind: "read" as const, title: "Fix suite > a test: expected 503 to be retried" },
        ];
        yield* recordVerdict(LANE, {
          ...verdict(first.batchId, first.candidateId, first.instanceId, "bounce"),
          nextActions: remedy,
        });
        expect(yield* payloads("VerdictIssued")).toEqual([
          expect.objectContaining({ outcome: "bounce", nextActions: remedy }),
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.declined] trunk declining the green batch invalidates it on its members, and the lane forms the next",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        const first = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "land"),
        );
        yield* deliver(
          envelope(
            { kind: "trunk", id: PROJECT },
            {
              _tag: "PromotionDeclined",
              projectId: PROJECT,
              batchId: first.batchId,
              reason: "commutation-failed",
              reverify: [change(1)],
            },
          ),
        );
        yield* laneStep(LANE);
        const invalidated = (yield* committed).filter((e) => e.type === "CandidateInvalidated");
        expect(invalidated.map((e) => [e.payload, e.affected])).toEqual([
          [
            {
              _tag: "CandidateInvalidated",
              candidateId: first.candidateId,
              batchId: first.batchId,
              reason: "head-moved",
            },
            [changeRef(change(1))],
          ],
        ]);
        expect(batchOf(yield* EntityStore, first.batchId)?.state).toBe("invalidated");
        expect((yield* payloads("BatchFormed")).map((p) => p["members"])).toEqual([
          [change(1)],
          [change(2)],
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.forms-on-trunk-head] a staging off the trunk head the lane heard is moved there from wherever it is before the next batch forms on it",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        // Staging moved some other way: the move starts from where it is, not from the advance's `from`.
        const elsewhere = yield* w.code.fixture.commit(STAGING, MAIN, { "README.md": "other\n" });
        const landed = sha("e");
        yield* advance(base, landed, []);
        yield* queue(w, change(1));
        yield* laneStep(LANE);
        expect(w.staging.moved).toEqual([{ from: elsewhere, to: landed }]);
        expect(yield* payloads("BatchFormed")).toEqual([
          expect.objectContaining({ members: [change(1)], base: landed }),
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.no-form-off-trunk] a staging that cannot be moved to trunk's head forms nothing, and the step fails to be retried",
    () => {
      const w = world({ stagingStuck: true });
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* advance(base, sha("e"), []);
        yield* queue(w, change(1));
        expect(Exit.isFailure(yield* Effect.exit(laneStep(LANE)))).toBe(true);
        expect(yield* payloads("BatchFormed")).toEqual([]);
        expect(laneOf(yield* EntityStore, LANE)?.queue).toEqual([change(1)]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.staging-ff] trunk's advance promotes the green batch, and the next batch moves staging onto the new head before forming on it",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        const first = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "land"),
        );
        const landed = sha("e");
        yield* advance(base, landed, [change(1)]);
        yield* laneStep(LANE);
        expect(yield* payloads("CandidatePromoted")).toEqual([
          {
            _tag: "CandidatePromoted",
            batchId: first.batchId,
            candidateId: first.candidateId,
            trunkSha: landed,
          },
        ]);
        expect(w.staging.moved).toEqual([{ from: base, to: landed }]);
        expect((yield* payloads("BatchFormed"))[1]).toMatchObject({
          members: [change(2)],
          base: landed,
        });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.reoffer] a green batch trunk has not answered is re-offered as its own BatchVerified under a fresh dedupe key, 30 s on and then every 60 s, until trunk answers",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        const first = yield* toVerifying(w);
        expect(yield* reofferDue(LANE)).toBeUndefined();
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "land"),
        );
        const verified = (yield* committed).find((e) => e.type === "BatchVerified");
        if (verified === undefined) throw new Error("the lane committed no BatchVerified");
        expect(yield* reofferDue(LANE)).toBe(verified.at + 30_000);
        w.clock.advance(30_000);
        expect(yield* reofferVerified(LANE)).toEqual({
          subscriber: `trunk:${PROJECT}`,
          envelope: { ...verified, dedupeKey: `${verified.dedupeKey}#reoffer-1` },
          count: 1,
        });
        expect(yield* reofferDue(LANE)).toBe(w.clock.now() + 60_000);
        w.clock.advance(60_000);
        expect((yield* reofferVerified(LANE))?.envelope.dedupeKey).toBe(
          `${verified.dedupeKey}#reoffer-2`,
        );
        yield* advance(base, sha("e"), [change(1)]);
        yield* laneStep(LANE);
        expect(yield* reofferDue(LANE)).toBeUndefined();
        expect(yield* reofferVerified(LANE)).toBeUndefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.bundle-refused] a candidate the bundle cannot carry fails through RefuseBundle with the verdict first, and is never verified",
    () => {
      const w = world({
        bundles: Layer.succeed(
          CandidateBundles,
          CandidateBundles.of({
            bundle: () =>
              Effect.fail(new BundleRefused({ reason: "a writer refusal with no entry" })),
          }),
        ),
      });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        expect(yield* laneStep(LANE)).toBe("idle");
        expect((yield* heardBy(`change:${change(1)}`)).map((e) => e.type)).toEqual([
          "BatchFormed",
          "VerdictIssued",
          "BatchFailed",
        ]);
        expect((yield* payloads("VerdictIssued"))[0]).toMatchObject({
          outcome: "bounce",
          evidence: ["bundle-refused: a writer refusal with no entry"],
        });
        expect((yield* payloads("BatchFailed"))[0]).toMatchObject({ attribution: "infra" });
        expect(w.verification.started.size).toBe(0);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    `[lane.infra-limit] the third infra failure in a row bounces the change with every reason and a remedy, instead of looping`,
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        for (let round = 1; round <= 3; round += 1) {
          const { batchId, candidateId, instanceId } = yield* toVerifying(w);
          yield* recordVerdict(LANE, verdict(batchId, candidateId, instanceId, "park"));
          yield* requeue(change(1), batchId);
        }
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual([
          "infra",
          "infra",
          change(1),
        ]);
        const last = (yield* payloads("VerdictIssued")).at(-1);
        expect(last).toMatchObject({
          outcome: "bounce",
          evidence: [
            "infra-failure x3: park: park: the suite said so; park: park: the suite said so; park: park: the suite said so",
            "park: the suite said so",
          ],
          nextActions: [
            { kind: "call", operationId: "submit", args: { changeId: change(1) } },
            { kind: "wait" },
          ],
        });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.unverified] with verification off the batch is verified unbundled, without KeelVerify, and says so",
    () => {
      const w = world({ verification: "off" });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect((yield* committed).map((e) => e.type)).toEqual([
          "BatchFormed",
          "CandidateAssembled",
          "VerificationStarted",
          "VerdictIssued",
          "BatchVerified",
        ]);
        expect((yield* payloads("VerdictIssued"))[0]).toMatchObject({
          outcome: "land",
          verified: false,
        });
        expect((yield* payloads("BatchVerified"))[0]).toMatchObject({ verified: false });
        expect(w.verification.started.size).toBe(0);
        expect(w.bundles.bundled).toEqual([]);
      }).pipe(Effect.provide(w.layer));
    },
  );
});

describe("bundleBlame", () => {
  it.effect(
    "[lane.bundle-blame] blames the member whose restacked commit adds the entry, and infra when the base holds it",
    () => {
      const code = makeCodeHostMemory();
      const repo = { namespace: "memory", name: "blame" };
      const link = { mode: "120000", data: "README.md" } as const;
      return Effect.gen(function* () {
        yield* (yield* CodeHost).create(repo);
        const base = yield* code.fixture.commit(repo, MAIN, { "README.md": "keel\n", old: link });
        const one = yield* code.fixture.commit(repo, MAIN, {
          "README.md": "keel\n",
          old: link,
          "lib/new": link,
        });
        const two = yield* code.fixture.commit(repo, MAIN, {
          "README.md": "keel\n",
          old: link,
          "lib/new": link,
          "b.txt": "two\n",
        });
        const chain = [
          { changeId: change(1), sha: one },
          { changeId: change(2), sha: two },
        ];
        expect(yield* bundleBlame(repo, "lib/new", base, chain)).toBe(change(1));
        expect(yield* bundleBlame(repo, "b.txt", base, chain)).toBe(change(2));
        expect(yield* bundleBlame(repo, "old", base, chain)).toBe("infra");
      }).pipe(Effect.provide(code.layer));
    },
  );
});
