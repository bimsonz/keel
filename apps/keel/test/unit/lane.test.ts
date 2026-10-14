// The Lane's use-cases over in-memory ports: one batch of one in flight, in
// FIFO order, decided by the domain's Candidate machine. Deliveries are
// handed to `laneHeard` as the Lane DO's receive would; each step runs
// `laneStep` as the `lane step` alarm would.
import { describe, expect, it } from "@effect/vitest";
import {
  batchOf,
  bundleBlame,
  checkVerification,
  destroyLane,
  instanceEnded,
  instanceOf,
  laneDestroyed,
  laneHeard,
  laneOf,
  laneStanding,
  laneOfInstance,
  laneStep,
  projectRepos,
  recordVerdict,
  reofferDue,
  reofferVerified,
  VERIFY_BUDGET_MS,
  verificationDue,
} from "@keeltown/core/application/integration";
import type { Change } from "@keeltown/core/domain/coordination";
import type { Agent } from "@keeltown/core/domain/identity";
import type { VerdictOutcome } from "@keeltown/core/domain/verification";
import {
  type AgentId,
  BatchId,
  type CandidateId,
  type ChangeId,
  CommitSha,
  type ContentHash,
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
  makeAgentDirectoryMemory,
  makeBatchVerificationMemory,
  makeCandidateBundlesMemory,
  makeCandidateComposerMemory,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLanesMemory,
  makeManualClock,
  makePlacedProject,
  makeProjectsMemory,
  makeStagingWriterMemory,
  suitePlan,
  workerAppPlan,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import { ulid } from "ulid";

const PROJECT = makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const LANE = `lane:${PROJECT}:main`;
const STAGING = projectRepos(PROJECT).staging;
const MAIN = "refs/heads/main";
const AGENT = makeId("agt", "01J9AAAAAAAAAAAAAAAAAAAAAA");
const OTHER_AGENT = makeId("agt", "01J9BBBBBBBBBBBBBBBBBBBBBB");
const RUN = makeId("run", "01J9RRRRRRRRRRRRRRRRRRRRRR");
const FAR = Instant(9_999_999_999_999);
/** An agent as the directory holds one that signed up by key: with the handle it was given. */
const signedUp = (id: AgentId, handle: string): Agent => ({
  id,
  handle,
  name: handle,
  scopes: ["agent:read", "agent:work"],
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(0),
});
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const change = (n: number): ChangeId => makeId("chg", `01J9C${String(n).padStart(21, "0")}`);

/** The plan Precheck compiled for a queued change, as its ChangeQueued names it. */
const PLAN = suitePlan();
const changeRef = (id: ChangeId): EntityRef => ({ kind: "change", id });

interface WorldOptions {
  readonly refuseCompose?: readonly ChangeId[];
  /** Why the composer refuses `refuseCompose`'s changes: GitCore's `overlap` unless given. */
  readonly refuseReason?: string;
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
      adopt: () => Effect.die(new Error("the Lane never adopts")),
      rebase: () => Effect.die(new Error("the Lane never rebases")),
      commit: () => Effect.die(new Error("the Lane never commits")),
      refreshWorkspace: () => Effect.die(new Error("the Lane never refreshes a workspace")),
      revise: () => Effect.die(new Error("the Lane never revises")),
      rely: () => Effect.die(new Error("the Lane never relies")),
      distinguish: () => Effect.die(new Error("the Lane never distinguishes")),
      nearby: () => Effect.die(new Error("the Lane never reads nearby")),
      abandon: () => Effect.die(new Error("the Lane never abandons")),
      get: (id) =>
        Effect.suspend(() => {
          const found = changes.get(id);
          return found === undefined
            ? Effect.die(new Error(`no ${id}`))
            : Effect.succeed({ change: found, projectId: PROJECT });
        }),
      workspace: (id) =>
        Effect.succeed({
          workspaceId: makeId("wsp", ulid()),
          repo: { namespace: "memory", name: `ws-${id}` },
          baseSha: sha("0"),
          grantedSha: sha("0"),
          projectId: PROJECT,
        }),
      declare: () => Effect.die(new Error("the Lane never declares")),
      submit: () => Effect.die(new Error("the Lane never submits")),
      awaitSubmission: () => Effect.die(new Error("the Lane never waits on a submission")),
    }),
  );
  // What the batch's state is when KeelVerify is started: it must already be Verifying.
  const startedIn: string[] = [];
  /** `look` runs as an instance's standing is read, before the answer: what happened to the lane meanwhile. */
  const hooks: { look?: (store: (typeof EntityStore)["Service"]) => void } = {};
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
        standing: (instanceId) =>
          Effect.suspend(() => {
            hooks.look?.(store);
            return inner.standing(instanceId);
          }),
        stop: inner.stop,
      });
    }),
  ).pipe(Layer.provide(Layer.merge(verification.layer, outbox.layer)));
  const composing = makeCandidateComposerMemory({
    refuse: options.refuseCompose ?? [],
    ...(options.refuseReason === undefined ? {} : { reason: options.refuseReason }),
  });
  const directory = makeAgentDirectoryMemory();
  const composer = composing.layer;
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
    makePlacedProject(PROJECT).layer,
    directory.layer,
    changesLayer,
  );
  const seeded = Effect.gen(function* () {
    (yield* EventOutbox).subscribe("projector", "*");
    yield* (yield* CodeHost).create(STAGING);
    return yield* code.fixture.commit(STAGING, MAIN, { "README.md": "keel\n" });
  });
  return {
    code,
    clock,
    verification,
    bundles,
    staging,
    changes,
    /** The agent directory the Lane reads handles from: empty until a test writes an agent. */
    agents: directory.agents,
    startedIn,
    hooks,
    layer,
    seeded,
    /** Every compose the lane asked for, as it asked. */
    composed: composing.requests,
  };
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

/** Queues the change with the plan its ChangeQueued names (`null`: an event from before plans were named). */
const queue = (w: World, id: ChangeId, planHash: ContentHash | null = PLAN.planHash) =>
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
      envelope(changeRef(id), {
        _tag: "ChangeQueued",
        changeId: id,
        laneId: LANE,
        ...(planHash === null ? {} : { planHash }),
      }),
    );
  });

const requeue = (id: ChangeId, batchId: BatchId, planHash: ContentHash = PLAN.planHash) =>
  deliver(
    envelope(changeRef(id), {
      _tag: "ChangeRequeued",
      changeId: id,
      batchId,
      reason: "infra-failure",
      planHash,
    }),
  );

const parked = (id: ChangeId, reason: string) =>
  deliver(envelope(changeRef(id), { _tag: "ChangeParked", changeId: id, reason }));
const resumed = (id: ChangeId) =>
  deliver(
    envelope(changeRef(id), {
      _tag: "ChangeResumed",
      changeId: id,
      decisionId: makeId("dec", "01J9KKKKKKKKKKKKKKKKKKKKKK"),
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
  planHash: PLAN.planHash,
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

/** The stored batch with one more member, as a lane that batches several changes would hold it. */
const withMember = (stored: unknown, member: ChangeId) => {
  if (!isRecord(stored) || !Array.isArray(stored["members"])) throw new Error("no batch is stored");
  return { ...stored, members: [...stored["members"], member] };
};

describe("the Lane", () => {
  it.effect(
    "[lane.status] a lane's two counts are of changes: those queued, and the members of the batch in flight, which left the queue when it formed and are in flight until the lane lets the batch go, landed or sent back; a lane no change ever joined holds none",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const seen: (readonly [string, { readonly queued: number; readonly inFlight: number }])[] =
          [];
        const look = (when: string) =>
          Effect.map(laneStanding(LANE), (standing) => void seen.push([when, standing]));
        yield* look("never used");
        const base = yield* w.seeded;
        for (const n of [1, 2, 3]) yield* queue(w, change(n));
        yield* look("three queued");
        const first = yield* toVerifying(w);
        yield* look("the first verifying");
        // A batch of two is two changes in flight, not one batch.
        const store = yield* EntityStore;
        const formed = store.get("batch", first.batchId);
        store.put("batch", first.batchId, withMember(formed, change(9)));
        yield* look("a batch of two");
        if (formed !== undefined) store.put("batch", first.batchId, formed);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "land"),
        );
        yield* laneStep(LANE);
        yield* look("green, waiting on trunk");
        yield* advance(base, sha("d"), [change(1)]);
        // The lane lets the landed batch go in its next step, which forms the next one.
        yield* look("its landing heard");
        const second = yield* toVerifying(w);
        yield* look("the second verifying");
        yield* recordVerdict(
          LANE,
          verdict(second.batchId, second.candidateId, second.instanceId, "bounce"),
        );
        yield* look("bounced");
        yield* toVerifying(w);
        yield* look("the third verifying");
        expect(seen).toEqual([
          ["never used", { queued: 0, inFlight: 0 }],
          ["three queued", { queued: 3, inFlight: 0 }],
          ["the first verifying", { queued: 2, inFlight: 1 }],
          ["a batch of two", { queued: 2, inFlight: 2 }],
          ["green, waiting on trunk", { queued: 2, inFlight: 1 }],
          ["its landing heard", { queued: 2, inFlight: 1 }],
          ["the second verifying", { queued: 1, inFlight: 1 }],
          ["bounced", { queued: 1, inFlight: 0 }],
          ["the third verifying", { queued: 0, inFlight: 1 }],
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

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
    "[t35.lane-holds] a change parked for a person's ruling while queued is never batched; resumed, it rejoins at the front under the plan it was queued with",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        yield* queue(w, change(3));
        yield* parked(change(1), "awaiting-ruling");
        // A lapsed lease parks an agent-owned change, which is in no queue: it moves nothing here.
        yield* parked(change(2), "lease-lapsed");
        const held = laneOf(yield* EntityStore, LANE);
        // A change this lane never queued is not its to take.
        yield* resumed(change(9));
        yield* resumed(change(1));
        const back = laneOf(yield* EntityStore, LANE);
        // Parked again and then withdrawn: it leaves for good, its plan with it.
        yield* parked(change(1), "awaiting-ruling");
        yield* deliver(
          envelope(changeRef(change(1)), {
            _tag: "ChangeWithdrawn",
            changeId: change(1),
            by: "agent",
          }),
        );
        yield* resumed(change(1));
        const gone = laneOf(yield* EntityStore, LANE);
        yield* laneStep(LANE);

        expect(held?.queue).toEqual([change(2), change(3)]);
        expect(held?.plans?.map((plan) => plan.changeId)).toContain(change(1));
        expect(back?.queue).toEqual([change(1), change(2), change(3)]);
        expect(gone?.queue).toEqual([change(2), change(3)]);
        expect(gone?.plans?.map((plan) => plan.changeId)).not.toContain(change(1));
        expect((yield* payloads("BatchFormed")).flatMap((p) => p["members"])).not.toContain(
          change(1),
        );
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[t35.lane-holds] a change requeued and parked in one commit leaves the queue under the plan its requeue named, and rejoins at the front when resumed",
    () => {
      const w = world();
      const recompiled = workerAppPlan();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        const first = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "park"),
        );
        yield* requeue(change(1), first.batchId, recompiled.planHash);
        const requeued = laneOf(yield* EntityStore, LANE);
        yield* parked(change(1), "awaiting-ruling");
        const held = laneOf(yield* EntityStore, LANE);
        yield* resumed(change(1));
        const back = laneOf(yield* EntityStore, LANE);

        expect(requeued?.queue).toEqual([change(1), change(2)]);
        expect(held?.queue).toEqual([change(2)]);
        expect(held?.plans?.find((plan) => plan.changeId === change(1))?.planHash).toBe(
          recompiled.planHash,
        );
        expect(back?.queue).toEqual([change(1), change(2)]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.drops-bounced] a change bounced while queued leaves the queue, and the next step forms the change behind it",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        yield* deliver(
          envelope(changeRef(change(1)), {
            _tag: "ChangeBounced",
            changeId: change(1),
            conflictId: makeId("cfl", ulid()),
            reasons: ["a conflict was proven against it"],
          }),
        );
        expect(laneOf(yield* EntityStore, LANE)?.queue).toEqual([change(2)]);
        yield* laneStep(LANE);
        expect((yield* payloads("BatchFormed")).map((p) => p["members"])).toEqual([[change(2)]]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.bounced-in-flight] a bounce of the member in flight leaves its batch as it was, and once that batch fails the Lane does not put the member back",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const first = yield* toVerifying(w);
        const before = laneOf(yield* EntityStore, LANE);
        yield* deliver(
          envelope(changeRef(change(1)), {
            _tag: "ChangeBounced",
            changeId: change(1),
            verdictId: makeId("vrd", ulid()),
            reasons: ["its own verdict"],
          }),
        );
        expect(laneOf(yield* EntityStore, LANE)).toEqual(before);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "park"),
        );
        expect(yield* payloads("BatchFailed")).toHaveLength(1);
        yield* laneStep(LANE);
        expect(laneOf(yield* EntityStore, LANE)?.queue).toEqual([]);
        expect((yield* payloads("BatchFormed")).map((p) => p["members"])).toEqual([[change(1)]]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.member-author] names each member's agent to the composer as the change records it, with the handle the directory holds for it and the run that holds the change: not its lease's holder, and nothing its commit says",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const queued = w.changes.get(change(1));
        if (queued === undefined) throw new Error("the change was not queued");
        // Another agent holds the lease: the author is the change's own agent all the same.
        w.changes.set(change(1), {
          ...queued,
          run: { id: RUN },
          lease: { ...queued.lease, agentId: OTHER_AGENT },
        });
        w.agents.set(AGENT, signedUp(AGENT, "agent-01j9aaaaaaaaaaaa"));
        w.agents.set(OTHER_AGENT, signedUp(OTHER_AGENT, "agent-01j9bbbbbbbbbbbb"));
        yield* toVerifying(w);
        expect(w.composed.map((request) => request.members.map((m) => m.agent))).toStrictEqual([
          [{ id: AGENT, handle: "agent-01j9aaaaaaaaaaaa", run: RUN }],
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.member-plain] names an agent the directory holds no handle for by its id alone, and no run for a change that none holds",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* toVerifying(w);
        expect(w.composed.map((request) => request.members.map((m) => m.agent))).toStrictEqual([
          [{ id: AGENT, handle: undefined, run: undefined }],
        ]);
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
    "[lane.verify-start] commits VerificationStarted, then starts KeelVerify once, named by BatchFormed, under the member's plan",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, candidateId, instanceId } = yield* toVerifying(w);
        const formed = (yield* committed).find((e) => e.type === "BatchFormed");
        expect(instanceId).toBe(`keel-verify-${PROJECT}-main-${formed?.eventId}`);
        expect(w.verification.started.get(instanceId)).toMatchObject({
          projectId: PROJECT,
          namespace: "org_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
          laneId: LANE,
          candidateId,
          fence: { batchId, attempt: 0, chainEpoch: 0 },
          planHash: PLAN.planHash,
          bundle: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });
        // The candidate was bundled for the project's namespace, the one the job names.
        expect(w.bundles.namespaces).toEqual(["org_01JZ8PT2C4E6G8J0M2N4Q6S8V0"]);
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
    "[lane.composition-refused] a refused composition bounces its change with the reason and the rebase-then-merge remedy, and never bundles or verifies",
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
          evidence: ["composition-refused: overlap"],
          nextActions: [
            {
              kind: "call",
              operationId: "rebase",
              args: { changeId: change(1) },
              title: expect.stringContaining(base),
            },
            {
              kind: "call",
              operationId: "submit",
              args: { changeId: change(1) },
              title: expect.stringContaining("git fetch origin keel/trunk && git merge FETCH_HEAD"),
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
    "[lane.box-infra] a composition MergeBox refuses for its own sake is held and blamed on infra, never the change, and the third in a row bounces the change to submit again unchanged",
    () => {
      const w = world({ refuseCompose: [change(1)], refuseReason: "box-unavailable" });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        for (let round = 1; round <= 3; round += 1) {
          expect(yield* laneStep(LANE)).toBe("idle");
          const failed = (yield* payloads("BatchFailed")).at(-1);
          if (round < 3)
            yield* requeue(change(1), Schema.decodeUnknownSync(BatchId)(failed?.["batchId"]));
        }
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual([
          "infra",
          "infra",
          change(1),
        ]);
        const refusal = "composition-refused: box-unavailable";
        const issued = yield* payloads("VerdictIssued");
        expect(issued[0]).toMatchObject({
          outcome: "hold",
          evidence: [refusal],
          nextActions: [{ kind: "wait" }],
        });
        expect(issued.at(-1)).toMatchObject({
          outcome: "bounce",
          evidence: [`infra-failure x3: ${refusal}; ${refusal}; ${refusal}`, refusal],
          nextActions: [
            { kind: "call", operationId: "submit", args: { changeId: change(1) } },
            { kind: "wait" },
          ],
        });
        expect(w.bundles.bundled).toEqual([]);
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
    "[lane.destroy] a destroyed lane drops its queue and its batch in flight: it forms nothing and re-offers nothing, however often it is destroyed",
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
        // Trunk has not answered: the green batch is due a re-offer, and change 2 waits behind it.
        expect(yield* reofferDue(LANE)).toBeDefined();
        expect(laneDestroyed(yield* EntityStore, LANE)).toBe(false);
        const before = (yield* committed).map((e) => e.type);
        yield* destroyLane(LANE, "operator");
        yield* destroyLane(LANE, "operator again");
        expect(laneDestroyed(yield* EntityStore, LANE)).toBe(true);
        expect(yield* reofferDue(LANE)).toBeUndefined();
        expect(yield* reofferVerified(LANE)).toBeUndefined();
        expect(yield* laneStep(LANE)).toBe("idle");
        const lane = laneOf(yield* EntityStore, LANE);
        expect(lane?.queue).toEqual([]);
        expect(lane?.active).toBeUndefined();
        expect((yield* committed).map((e) => e.type)).toEqual(before);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.destroy-hears-nothing] a destroyed lane takes no change into its queue and notes no trunk advance, so it never forms again",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        // A lane that has held nothing yet is destroyed all the same.
        yield* destroyLane(LANE, "operator");
        expect(yield* queue(w, change(1))).toBe(false);
        expect(yield* advance(base, sha("e"), [])).toBe(false);
        expect(yield* laneStep(LANE)).toBe("idle");
        expect(laneOf(yield* EntityStore, LANE)?.queue ?? []).toEqual([]);
        expect(yield* payloads("BatchFormed")).toEqual([]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.destroy-verdict] a destroyed lane takes no verdict: KeelVerify's result for the batch it dropped is CandidateNotFound and commits nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, candidateId, instanceId } = yield* toVerifying(w);
        yield* destroyLane(LANE, "operator");
        const before = (yield* committed).map((e) => e.type);
        const refused = yield* Effect.flip(
          recordVerdict(LANE, verdict(batchId, candidateId, instanceId, "land")),
        );
        expect(refused).toMatchObject({ _tag: "CandidateNotFound", candidateId });
        expect((yield* committed).map((e) => e.type)).toEqual(before);
        expect(yield* heardBy(`trunk:${PROJECT}`)).toEqual([]);
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
    "[lane.step-killed] a step that died twice before its candidate was bundled refuses the bundle on the infrastructure without trying it again, and goes on to bundle the next batch as any step does",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        // The third start of one deadline: two invocations died under it.
        expect(yield* laneStep(LANE, 3)).toBe("waiting");
        expect((yield* payloads("VerdictIssued"))[0]).toMatchObject({
          outcome: "bounce",
          evidence: [
            "bundle-refused: the lane's step was killed 2 times before the candidate was bundled",
          ],
        });
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual(["infra"]);
        // The deaths counted against the first bundle alone: the second change's was made, and is verifying.
        expect(w.bundles.bundled).toHaveLength(1);
        expect(w.verification.started.size).toBe(1);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect("[lane.step-killed-once] a step that died once bundles its candidate again", () => {
    const w = world();
    return Effect.gen(function* () {
      yield* w.seeded;
      yield* queue(w, change(1));
      expect(yield* laneStep(LANE, 2)).toBe("waiting");
      expect(w.bundles.bundled).toHaveLength(1);
      expect(yield* payloads("BatchFailed")).toEqual([]);
      expect(w.verification.started.size).toBe(1);
    }).pipe(Effect.provide(w.layer));
  });

  it.effect(
    "[lane.bundle-from-last] a bundle is told to take from the lane's last one, and a step retried after it died names the same",
    () => {
      const made = makeCandidateBundlesMemory();
      const step = { dies: false };
      const w = world({
        bundles: Layer.effect(
          CandidateBundles,
          Effect.gen(function* () {
            const inner = yield* CandidateBundles;
            return CandidateBundles.of({
              // The bundle is made and stored, and the step may be killed before the Lane notes it.
              bundle: (namespace, staging, commit, from) =>
                inner
                  .bundle(namespace, staging, commit, from)
                  .pipe(
                    Effect.flatMap((hash) =>
                      step.dies
                        ? Effect.die(new Error("the step was killed"))
                        : Effect.succeed(hash),
                    ),
                  ),
            });
          }),
        ).pipe(Layer.provide(made.layer)),
      });
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* queue(w, change(1));
        const first = yield* toVerifying(w);
        const last = (yield* inFlight).bundle;
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "bounce"),
        );
        yield* advance(base, base, []);
        yield* queue(w, change(2));
        step.dies = true;
        expect(Exit.isFailure(yield* Effect.exit(laneStep(LANE)))).toBe(true);
        step.dies = false;
        yield* toVerifying(w);
        expect(last).toBeDefined();
        // The first has none to take from; the second names the first's, and so does its retry.
        expect(made.froms).toEqual([undefined, last, last]);
        // The next will name the second's.
        expect(laneOf(yield* EntityStore, LANE)?.lastBundle).toBe((yield* inFlight).bundle);
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
    "[d21.member-hash] each batch is verified under the plan its member was queued with",
    () => {
      const w = world();
      const other = workerAppPlan();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2), other.planHash);
        const first = yield* toVerifying(w);
        expect(w.verification.started.get(first.instanceId)?.planHash).toBe(PLAN.planHash);
        expect(yield* payloads("VerificationStarted")).toEqual([
          expect.objectContaining({ planHash: PLAN.planHash }),
        ]);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "bounce"),
        );
        const second = yield* toVerifying(w);
        expect(w.verification.started.get(second.instanceId)?.planHash).toBe(other.planHash);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[d21.requeue-keeps-hash] a requeued change is verified again under the plan its ChangeRequeued names",
    () => {
      const w = world();
      const recompiled = workerAppPlan();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const first = yield* toVerifying(w);
        yield* recordVerdict(
          LANE,
          verdict(first.batchId, first.candidateId, first.instanceId, "park"),
        );
        yield* requeue(change(1), first.batchId, recompiled.planHash);
        const again = yield* toVerifying(w);
        expect(w.verification.started.get(again.instanceId)?.planHash).toBe(recompiled.planHash);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[d21.no-hash-refused] a change queued with no plan is bounced before composition, with the remedy of submitting again",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1), null);
        expect(yield* laneStep(LANE)).toBe("idle");
        expect((yield* committed).map((e) => e.type)).toEqual([
          "BatchFormed",
          "VerdictIssued",
          "BatchFailed",
        ]);
        expect((yield* payloads("VerdictIssued"))[0]).toMatchObject({
          outcome: "bounce",
          evidence: [expect.stringContaining("plan-missing")],
          nextActions: [{ kind: "call", operationId: "submit", args: { changeId: change(1) } }],
        });
        expect((yield* payloads("BatchFailed"))[0]).toMatchObject({ attribution: change(1) });
        expect(w.verification.started.size).toBe(0);
        expect(w.bundles.bundled).toEqual([]);
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

/** The newest event of a type the lane committed. */
const last = (type: string) => Effect.map(payloads(type), (found) => found.at(-1));
/** What `infraBlame` keeps of a terminated instance's failure. */
const terminatedReason = (instanceId: string | undefined) =>
  `park: verification-failed: instance ${instanceId} terminated`;

describe("the Lane's verification that sends no verdict", () => {
  const ERRORED = { _tag: "Failed", status: "errored", error: "not a KeelVerify job" } as const;

  it.effect(
    "[lane.instance-id] a batch's KeelVerify instance names its lane, which is read back from the id; an id the Lane did not make names none, and a lane the id cannot carry is a defect",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { instanceId } = yield* toVerifying(w);
        const formed = (yield* committed).find((e) => e.type === "BatchFormed");
        expect(instanceId).toBe(`keel-verify-${PROJECT}-main-${formed?.eventId}`);
        expect(laneOfInstance(instanceId)).toBe(LANE);
        const event = `evt_${"0".repeat(26)}`;
        const dashed = `lane:${PROJECT}:hot-fix_2`;
        expect(laneOfInstance(instanceOf(dashed, event))).toBe(dashed);
        const longest = `lane:${PROJECT}:${"x".repeat(26)}`;
        expect(instanceOf(longest, event)).toHaveLength(100);
        expect(laneOfInstance(instanceOf(longest, event))).toBe(longest);
        for (const foreign of [
          `keel-verify-${formed?.eventId}`,
          `keel-world-check-${PROJECT}-main-${event}`,
          `keel-verify-prj_nope-main-${event}`,
          "",
        ])
          expect(laneOfInstance(foreign)).toBeUndefined();
        expect(() => instanceOf(`lane:${PROJECT}:${"x".repeat(27)}`, event)).toThrow(/at most 100/);
        expect(() => instanceOf(`lane:${PROJECT}:a.b`, event)).toThrow(/letters, digits/);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.instance-failed] an instance that ended in error fails its batch on the infrastructure, citing the instance and its error, and the lane moves on to the next change",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        const { batchId, instanceId } = yield* toVerifying(w);
        w.verification.end(instanceId, ERRORED);
        expect(yield* checkVerification(LANE, instanceId)).toBe("settled");
        expect(yield* last("VerdictIssued")).toMatchObject({
          subject: batchId,
          outcome: "park",
          planHash: PLAN.planHash,
          evidence: [`verification-failed: instance ${instanceId} errored: not a KeelVerify job`],
        });
        expect(yield* last("BatchFailed")).toMatchObject({ batchId, attribution: "infra" });
        expect(w.verification.stopped).toEqual([]);
        expect(laneOf(yield* EntityStore, LANE)?.active).toBeUndefined();
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect((yield* inFlight).batchId).not.toBe(batchId);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.instance-limit] a change whose instance fails is verified afresh twice, and bounced the third time in a row with every reason and its next actions",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const instances: string[] = [];
        for (let round = 1; round <= 3; round += 1) {
          const { batchId, instanceId } = yield* toVerifying(w);
          instances.push(instanceId);
          w.verification.end(instanceId, { _tag: "Failed", status: "terminated" });
          expect(yield* checkVerification(LANE, instanceId)).toBe("settled");
          yield* requeue(change(1), batchId);
        }
        expect(new Set(instances).size).toBe(3);
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual([
          "infra",
          "infra",
          change(1),
        ]);
        expect(yield* last("VerdictIssued")).toMatchObject({
          outcome: "bounce",
          evidence: [
            `infra-failure x3: ${instances.map(terminatedReason).join("; ")}`,
            `verification-failed: instance ${instances[2]} terminated`,
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
    "[lane.instance-hint] a report is a hint: an instance that reads as running, one that reads as completed, and another instance than the batch in flight's settle nothing, and the last is not even read",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, instanceId } = yield* toVerifying(w);
        expect(yield* checkVerification(LANE, instanceId)).toBe("running");
        w.verification.end(instanceId, { _tag: "Completed" });
        expect(yield* checkVerification(LANE, instanceId)).toBe("running");
        expect(w.verification.looked).toEqual([instanceId, instanceId]);
        w.verification.end(instanceId, ERRORED);
        expect(yield* checkVerification(LANE, `${instanceId}-earlier`)).toBe("idle");
        expect(w.verification.looked).toEqual([instanceId, instanceId]);
        expect(batchOf(yield* EntityStore, batchId)?.state).toBe("verifying");
        expect((yield* committed).map((e) => e.type)).not.toContain("VerdictIssued");
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.instance-budget] at the end of its budget the lane's step stops an instance still running and settles its batch, and settles one that completed with no verdict; a millisecond earlier it does neither",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const first = yield* toVerifying(w);
        w.clock.advance(VERIFY_BUDGET_MS - 1);
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect(w.verification.looked).toEqual([]);
        w.clock.advance(1);
        expect(w.clock.now()).toBe(yield* verificationDue(LANE));
        expect(yield* laneStep(LANE)).toBe("idle");
        expect(w.verification.stopped).toEqual([first.instanceId]);
        expect(yield* last("VerdictIssued")).toMatchObject({
          outcome: "park",
          evidence: [
            `verification-failed: instance ${first.instanceId} still running after 15 minutes, and was stopped`,
          ],
        });
        expect(yield* last("BatchFailed")).toMatchObject({
          batchId: first.batchId,
          attribution: "infra",
        });
        yield* requeue(change(1), first.batchId);
        const second = yield* toVerifying(w);
        w.verification.end(second.instanceId, { _tag: "Completed" });
        w.clock.advance(VERIFY_BUDGET_MS - 1);
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect(batchOf(yield* EntityStore, second.batchId)?.state).toBe("verifying");
        w.clock.advance(1);
        expect(yield* laneStep(LANE)).toBe("idle");
        expect(w.verification.stopped).toEqual([first.instanceId]);
        expect(yield* last("VerdictIssued")).toMatchObject({
          evidence: [
            `verification-failed: instance ${second.instanceId} completed without recording a verdict`,
          ],
        });
        expect(yield* last("BatchFailed")).toMatchObject({ batchId: second.batchId });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.verification-due] the budget is fifteen minutes from the batch's own VerificationStarted, however late it is asked, and runs only while the batch verifies",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        expect(yield* verificationDue(LANE)).toBeUndefined();
        yield* queue(w, change(1));
        expect(yield* verificationDue(LANE)).toBeUndefined();
        const { batchId, candidateId, instanceId } = yield* toVerifying(w);
        const started = (yield* committed).find((e) => e.type === "VerificationStarted");
        if (started === undefined) throw new Error("the lane committed no VerificationStarted");
        expect(yield* verificationDue(LANE)).toBe(started.at + 15 * 60_000);
        w.clock.advance(60_000);
        expect(yield* verificationDue(LANE)).toBe(started.at + 15 * 60_000);
        yield* recordVerdict(LANE, verdict(batchId, candidateId, instanceId, "land"));
        expect(batchOf(yield* EntityStore, batchId)?.state).toBe("green");
        expect(yield* verificationDue(LANE)).toBeUndefined();
        w.verification.end(instanceId, ERRORED);
        expect(yield* checkVerification(LANE, instanceId)).toBe("idle");
        expect(yield* payloads("BatchFailed")).toEqual([]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.late-verdict-fenced] a verdict that arrives after its batch was settled is ResultFenced and writes nothing, and looking again settles nothing more",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, candidateId, instanceId } = yield* toVerifying(w);
        w.verification.end(instanceId, ERRORED);
        expect(yield* checkVerification(LANE, instanceId)).toBe("settled");
        const before = (yield* committed).map((e) => e.type);
        const late = yield* Effect.flip(
          recordVerdict(LANE, verdict(batchId, candidateId, instanceId, "land")),
        );
        expect(late).toMatchObject({ _tag: "ResultFenced", batchId, attempt: 0, chainEpoch: 0 });
        expect(yield* checkVerification(LANE, instanceId)).toBe("idle");
        expect((yield* committed).map((e) => e.type)).toEqual(before);
        expect(batchOf(yield* EntityStore, batchId)?.state).toBe("red");
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.instance-settled-once] a verdict recorded while the Lane was looking leaves nothing to settle: the look answers idle and commits nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const { batchId, instanceId } = yield* toVerifying(w);
        w.verification.end(instanceId, ERRORED);
        // The batch goes green between the Lane's read of its state and its commit, as a verdict's transaction would leave it.
        w.hooks.look = (store) => {
          const stored = store.get("batch", batchId);
          if (!isRecord(stored)) throw new Error("the lane holds no batch");
          store.put("batch", batchId, { ...stored, state: "green" });
        };
        expect(yield* checkVerification(LANE, instanceId)).toBe("idle");
        expect((yield* committed).map((e) => e.type)).not.toContain("VerdictIssued");
        expect(yield* payloads("BatchFailed")).toEqual([]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.instance-ended] a reported instance's lane, read from its id, is told; an id that names no lane is dropped",
    () => {
      const lanes = makeLanesMemory();
      return Effect.gen(function* () {
        const event = `evt_${"0".repeat(26)}`;
        const instanceId = instanceOf(LANE, event);
        expect(yield* instanceEnded(instanceId)).toBe("told");
        expect(yield* instanceEnded(`keel-verify-${event}`)).toBe("dropped");
        expect(lanes.ended).toEqual([{ laneId: LANE, instanceId }]);
      }).pipe(Effect.provide(lanes.layer));
    },
  );
});
