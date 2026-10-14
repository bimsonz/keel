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
  failureRate,
  instanceEnded,
  instanceOf,
  laneDestroyed,
  laneHeard,
  laneBatchSize,
  laneOf,
  laneStanding,
  laneOfInstance,
  laneStep,
  laneStepFailed,
  OUTCOME_WINDOW,
  projectRepos,
  recordVerdict,
  reofferDue,
  reofferVerified,
  STEP_FAILURES_BEFORE_INFRA,
  VERIFY_BUDGET_MS,
  verificationDue,
} from "@keeltown/core/application/integration";
import type { Change } from "@keeltown/core/domain/coordination";
import type { Agent } from "@keeltown/core/domain/identity";
import { unionPlans, type VerdictOutcome } from "@keeltown/core/domain/verification";
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
  PlanStore,
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
  makePlanStoreMemory,
  makeProjectsMemory,
  makeStagingWriterMemory,
  sampleNamespace,
  suitePlan,
  workerAppPlan,
} from "@keeltown/testing";
import { Cause, Effect, Exit, Layer, Result, Schema } from "effect";
import * as fc from "fast-check";
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
/** Another plan, so a batch of the two runs their union. */
const WORKER_PLAN = workerAppPlan();
const changeRef = (id: ChangeId): EntityRef => ({ kind: "change", id });

interface WorldOptions {
  readonly refuseCompose?: readonly ChangeId[];
  /** Why the composer refuses `refuseCompose`'s changes: GitCore's `overlap` unless given. */
  readonly refuseReason?: string;
  /** What failed where the composer saw it, with `refuseReason`. */
  readonly refuseDetail?: string;
  readonly bundles?: Layer.Layer<CandidateBundles>;
  readonly verification?: "required" | "off";
  readonly composer?: (inner: Layer.Layer<CandidateComposer>) => Layer.Layer<CandidateComposer>;
  /** Staging's main refuses every move, as a staging some other writer holds would. */
  readonly stagingStuck?: boolean;
  /** The project's largest batch: 1 unless given, so a case batches only when it says so. */
  readonly maxBatchSize?: number;
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
    maxBatchSize: options.maxBatchSize ?? 1,
    verification: options.verification ?? "required",
    visibility: "private",
  });
  const changes = new Map<ChangeId, Change>();
  /** The changes each change's own DO says it shares an unsettled conflict with. */
  const unsettled = new Map<ChangeId, readonly ChangeId[]>();
  const plans = makePlanStoreMemory();
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
          const others = unsettled.get(id);
          return found === undefined
            ? Effect.die(new Error(`no ${id}`))
            : Effect.succeed({
                change: found,
                projectId: PROJECT,
                ...(others === undefined ? {} : { unsettled: others }),
              });
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
  const hooks: {
    look?: (store: (typeof EntityStore)["Service"]) => void;
    /** Runs as KeelVerify is started, before it is: a start that throws dies as the binding's would. */
    start?: () => void;
  } = {};
  const recordingVerification = Layer.effect(
    BatchVerification,
    Effect.gen(function* () {
      const inner = yield* BatchVerification;
      const store = yield* EntityStore;
      return BatchVerification.of({
        start: (instanceId, job) =>
          Effect.suspend(() => {
            startedIn.push(batchOf(store, job.fence.batchId)?.state ?? "none");
            hooks.start?.();
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
    ...(options.refuseDetail === undefined ? {} : { detail: options.refuseDetail }),
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
    plans.layer,
  );
  const seeded = Effect.gen(function* () {
    (yield* EventOutbox).subscribe("projector", "*");
    // The plans Precheck stored for the changes it queued.
    for (const plan of [PLAN, WORKER_PLAN]) yield* (yield* PlanStore).put(sampleNamespace, plan);
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
    unsettled,
    plans,
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
/** What a bundle past the object's memory throws. */
const OOM = "RangeError: Array buffer allocation failed";
const COMPOSE_DIED = "Error: staging could not be read";
/** The rounds of infra failures after which the Lane bounces a change. */
const INFRA_ROUNDS = 3;

/** A bundler that throws on its first `dies` calls, as one past the object's memory does, then bundles. */
function dyingBundler(dies: number) {
  const made = makeCandidateBundlesMemory();
  const calls = { count: 0 };
  const layer = Layer.effect(
    CandidateBundles,
    Effect.gen(function* () {
      const inner = yield* CandidateBundles;
      return CandidateBundles.of({
        bundle: (namespace, staging, commit, from) =>
          Effect.suspend(() => {
            calls.count += 1;
            return calls.count <= dies
              ? Effect.die(new RangeError("Array buffer allocation failed"))
              : inner.bundle(namespace, staging, commit, from);
          }),
      });
    }),
  ).pipe(Layer.provide(made.layer));
  return { layer, calls };
}

/** A composer that throws on its first `dies` calls, then composes. */
function dyingComposer(dies: number) {
  const calls = { count: 0 };
  const wrap = (inner: Layer.Layer<CandidateComposer>) =>
    Layer.effect(
      CandidateComposer,
      Effect.gen(function* () {
        const composer = yield* CandidateComposer;
        return CandidateComposer.of({
          compose: (request) =>
            Effect.suspend(() => {
              calls.count += 1;
              return calls.count <= dies
                ? Effect.die(new Error("staging could not be read"))
                : composer.compose(request);
            }),
        });
      }),
    ).pipe(Layer.provide(inner));
  return { wrap, calls };
}

/** A step that throws, as the Lane DO runs one: what it threw is recorded with the batch's attempt. */
const throwingStep = Effect.gen(function* () {
  const exit = yield* Effect.exit(laneStep(LANE));
  if (Exit.isSuccess(exit)) yield* Effect.die(new Error("the step was meant to throw"));
  else {
    const thrown = Cause.squash(exit.cause);
    yield* laneStepFailed(
      LANE,
      thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
    );
  }
});

/** A step whose invocation dies: nothing is recorded after it. */
const dyingStep = Effect.gen(function* () {
  const exit = yield* Effect.exit(laneStep(LANE));
  if (Exit.isSuccess(exit)) yield* Effect.die(new Error("the step was meant to die"));
});

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
    "[lane.verify-start] commits VerificationStarted, then starts KeelVerify once, named by BatchFormed, under the member's plan, naming its members and its candidate's commit",
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
        // The deploy steps tell the batch's members, and record the candidate's own commit: never its tree.
        const job = w.verification.started.get(instanceId);
        const assembled = (yield* committed).find((e) => e.type === "CandidateAssembled");
        expect(job?.members).toEqual([change(1)]);
        expect(job?.candidateCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(job?.candidateCommit).not.toBe(Reflect.get(Object(assembled?.payload), "treeSha"));
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
    "[lane.box-cause] a box's failure is held with what failed in the box, in the hold's evidence and the bounce's",
    () => {
      const detail = "the box did not answer: the box was not readied: trust exit 124";
      const w = world({
        refuseCompose: [change(1)],
        refuseReason: "box-failed",
        refuseDetail: detail,
      });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        for (let round = 1; round <= 3; round += 1) {
          expect(yield* laneStep(LANE)).toBe("idle");
          const failed = (yield* payloads("BatchFailed")).at(-1);
          if (round < 3)
            yield* requeue(change(1), Schema.decodeUnknownSync(BatchId)(failed?.["batchId"]));
        }
        const refusal = `composition-refused: box-failed: ${detail}`;
        const issued = yield* payloads("VerdictIssued");
        expect(issued[0]).toMatchObject({ outcome: "hold", evidence: [refusal] });
        expect(issued.at(-1)).toMatchObject({
          outcome: "bounce",
          evidence: [`infra-failure x3: ${refusal}; ${refusal}; ${refusal}`, refusal],
        });
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
    "[lane.step-failures] a batch whose bundle threw in three steps is not bundled a fourth time: the fourth step holds it on the infrastructure with each step's error and a wait, starts no verification, and runs again",
    () => {
      const dying = dyingBundler(Number.POSITIVE_INFINITY);
      const w = world({ bundles: dying.layer });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        for (let step = 1; step <= STEP_FAILURES_BEFORE_INFRA; step += 1) yield* throwingStep;
        // Counted with the batch in the lane's own store: the throws before, and the attempt that threw last.
        expect(yield* inFlight).toMatchObject({
          failed: [`bundle: ${OOM}`, `bundle: ${OOM}`],
          attempt: { stage: "bundle", error: OOM },
        });
        expect(yield* laneStep(LANE)).toBe("again");
        expect(dying.calls.count).toBe(STEP_FAILURES_BEFORE_INFRA);
        expect((yield* payloads("VerdictIssued"))[0]).toMatchObject({
          outcome: "hold",
          evidence: [`step-failed x3: bundle: ${OOM}; bundle: ${OOM}; bundle: ${OOM}`],
          nextActions: [{ kind: "wait" }],
        });
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual(["infra"]);
        expect(w.verification.started.size).toBe(0);
        expect(laneOf(yield* EntityStore, LANE)?.active).toBeUndefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.step-killed] a step that dies mid-bundle counts as one that threw: two deaths and a throw fail the batch on the infrastructure, each cited, and the next batch is bundled untouched by them",
    () => {
      const dying = dyingBundler(3);
      const w = world({ bundles: dying.layer });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* queue(w, change(2));
        yield* dyingStep;
        yield* dyingStep;
        yield* throwingStep;
        expect(yield* laneStep(LANE)).toBe("again");
        const died = "bundle: the step died before it finished";
        expect((yield* payloads("VerdictIssued"))[0]).toMatchObject({
          outcome: "hold",
          evidence: [`step-failed x3: ${died}; ${died}; bundle: ${OOM}`],
        });
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual(["infra"]);
        // The next step forms the second change's batch: its first bundle is made, and it is verifying.
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect(dying.calls.count).toBe(4);
        expect(w.verification.started.size).toBe(1);
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual(["infra"]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.step-failed-once] a bundle that threw once is tried again, and its batch verifies with nothing failed",
    () => {
      const dying = dyingBundler(1);
      const w = world({ bundles: dying.layer });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        yield* throwingStep;
        expect(yield* laneStep(LANE)).toBe("waiting");
        expect(dying.calls.count).toBe(2);
        expect(yield* payloads("BatchFailed")).toEqual([]);
        expect(w.verification.started.size).toBe(1);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.step-failures-compose] a batch whose compose threw in three steps is held on the infrastructure as a refused composition, and never bundled",
    () => {
      const w = world({ composer: dyingComposer(Number.POSITIVE_INFINITY).wrap });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        for (let step = 1; step <= STEP_FAILURES_BEFORE_INFRA; step += 1) yield* throwingStep;
        expect(yield* laneStep(LANE)).toBe("again");
        expect((yield* payloads("VerdictIssued"))[0]).toMatchObject({
          outcome: "hold",
          evidence: [
            `step-failed x3: compose: ${COMPOSE_DIED}; compose: ${COMPOSE_DIED}; compose: ${COMPOSE_DIED}`,
          ],
        });
        expect(
          (yield* committed)
            .filter((e) => e.type === "BatchFailed" || e.type === "CandidateAssembled")
            .map((e) => e.type),
        ).toEqual(["BatchFailed"]);
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual(["infra"]);
        expect(w.bundles.bundled).toEqual([]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.step-failures-stages] a batch's failed attempts add up over its compose, bundle and start: the third, at its start, parks it on the infrastructure as KeelVerify's own failures are",
    () => {
      const dying = dyingBundler(1);
      const w = world({ composer: dyingComposer(1).wrap, bundles: dying.layer });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        w.hooks.start = () => {
          throw new Error("the Workflow binding is gone");
        };
        yield* throwingStep;
        yield* throwingStep;
        yield* throwingStep;
        expect(yield* laneStep(LANE)).toBe("again");
        const issued = yield* payloads("VerdictIssued");
        expect(issued).toHaveLength(1);
        expect(issued[0]?.["evidence"]).toEqual([
          expect.stringContaining(
            `step-failed x3: compose: ${COMPOSE_DIED}; bundle: ${OOM}; start: Error: the Workflow binding is gone`,
          ),
        ]);
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual(["infra"]);
        expect(w.verification.started.size).toBe(0);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[lane.step-failures-bounce] a change whose batch is failed on its steps a third time in a row bounces, told to submit again once the infrastructure is back",
    () => {
      const w = world({ bundles: dyingBundler(Number.POSITIVE_INFINITY).layer });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        for (let round = 1; round <= INFRA_ROUNDS; round += 1) {
          for (let step = 1; step <= STEP_FAILURES_BEFORE_INFRA; step += 1) yield* throwingStep;
          expect(yield* laneStep(LANE)).toBe("again");
          const failed = (yield* payloads("BatchFailed")).at(-1);
          if (round < INFRA_ROUNDS)
            yield* requeue(change(1), Schema.decodeUnknownSync(BatchId)(failed?.["batchId"]));
        }
        expect((yield* payloads("BatchFailed")).map((p) => p["attribution"])).toEqual([
          "infra",
          "infra",
          change(1),
        ]);
        expect((yield* payloads("VerdictIssued")).at(-1)).toMatchObject({
          outcome: "bounce",
          evidence: [
            expect.stringMatching(/^infra-failure x3: step-failed x3: /),
            expect.any(String),
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

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const fcSeed = process.env["FC_SEED"];
const fcRuns = { numRuns: 60, ...(fcSeed === undefined ? {} : { seed: Number(fcSeed) }) };

/** Trunk heads the cases advance to, one a landing. */
const head = (round: number) => sha("123456789abcdef"[round % 15] ?? "e");

/** The members of the batch in flight, as the lane formed it. */
const membersInFlight = Effect.gen(function* () {
  const active = yield* inFlight;
  return batchOf(yield* EntityStore, active.batchId)?.members ?? [];
});

/**
 * Lands every queued change the way trunk would, batch by batch: verify the
 * batch in flight, land it, and advance trunk naming its members, which the
 * lane follows into its next batch. Answers each batch's members in order.
 */
const landAll = (w: World, base: string, count: number) =>
  Effect.gen(function* () {
    const batches: (readonly ChangeId[])[] = [];
    let from = base;
    for (let landed = 0; landed < count;) {
      const v = yield* toVerifying(w);
      const members = yield* membersInFlight;
      batches.push(members);
      yield* recordVerdict(LANE, verdict(v.batchId, v.candidateId, v.instanceId, "land"));
      const to = head(batches.length);
      yield* advance(from, to, members);
      from = to;
      landed += members.length;
    }
    return batches;
  });

/** A change requeued by its own DO for `reason`, as it reacts to its batch's failure. */
const requeuedFor = (id: ChangeId, batchId: BatchId, reason: string) =>
  deliver(
    envelope(changeRef(id), {
      _tag: "ChangeRequeued",
      changeId: id,
      batchId,
      reason,
      planHash: PLAN.planHash,
    }),
  );

/** A lane whose latest member outcomes are `passes` passes, then `fails` failures. */
const laneWithOutcomes = (fails: number, passes = 0) => ({
  laneId: LANE,
  projectId: PROJECT,
  queue: [],
  advances: [],
  infra: [],
  outcomes: [
    ...Array.from({ length: passes }, () => "pass" as const),
    ...Array.from({ length: fails }, () => "fail" as const),
  ],
});

describe("the Lane batches (C4.1)", () => {
  it("[c41.size] a lane forms up to the project's maxBatchSize, fewer as its members' recent failure rate rises", () => {
    const lane = laneWithOutcomes;
    expect([0, 1, 2, 3].map((fails) => laneBatchSize(lane(fails), 16))).toEqual([16, 4, 2, 1]);
    expect([1, 8, 16].map((max) => laneBatchSize(lane(0), max))).toEqual([1, 8, 16]);
    expect(laneBatchSize(lane(1), 2)).toBe(2);
    // Only the latest twenty outcomes count: a failure twenty passes ago no longer shrinks the batch.
    expect(failureRate(lane(1, 0))).toBe(1 / OUTCOME_WINDOW);
  });

  it.effect(
    "[c41.group-commit] a lane batches the queue's head and up to N - 1 behind it in queue order, composes them as one candidate, verifies it once, and one trunk advance promotes them all",
    () => {
      const w = world({ maxBatchSize: 4 });
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        for (const n of [1, 2, 3, 4, 5, 6]) yield* queue(w, change(n));
        const v = yield* toVerifying(w);
        expect(yield* membersInFlight).toEqual([1, 2, 3, 4].map(change));
        expect(w.composed.map((request) => request.members.map((m) => m.changeId))).toEqual([
          [1, 2, 3, 4].map(change),
        ]);
        const job = w.verification.started.get(v.instanceId);
        expect(job?.members).toEqual([1, 2, 3, 4].map(change));
        expect(job?.planHash).toBe(PLAN.planHash);
        yield* recordVerdict(LANE, verdict(v.batchId, v.candidateId, v.instanceId, "land"));
        expect((yield* payloads("BatchVerified")).at(-1)?.["members"]).toEqual(
          [1, 2, 3, 4].map(change),
        );
        yield* advance(base, head(1), [1, 2, 3, 4].map(change));
        yield* toVerifying(w);
        expect((yield* payloads("CandidatePromoted")).map((p) => p["batchId"])).toEqual([
          v.batchId,
        ]);
        expect(yield* membersInFlight).toEqual([5, 6].map(change));
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[c41.union-plan] a batch of changes compiled under different plans runs the union of their plans, which the lane stores; a batch of one runs its member's plan unchanged",
    () => {
      const w = world({ maxBatchSize: 2 });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1), PLAN.planHash);
        yield* queue(w, change(2), WORKER_PLAN.planHash);
        const v = yield* toVerifying(w);
        const union = Result.getOrThrow(unionPlans([PLAN, WORKER_PLAN]));
        expect(union.planHash).not.toBe(PLAN.planHash);
        expect((yield* inFlight).planHash).toBe(union.planHash);
        expect(w.verification.started.get(v.instanceId)?.planHash).toBe(union.planHash);
        const stored = yield* (yield* PlanStore).get(sampleNamespace, union.planHash);
        expect(stored.members).toEqual([PLAN.planHash, WORKER_PLAN.planHash].toSorted());
      }).pipe(Effect.provide(w.layer));
    },
  );

  it("[c41.no-unsettled-pair] no batch the lane forms holds two changes that share an unsettled conflict, whichever of the two says so; every change is batched once, the head first", async () => {
    const cases = fc.integer({ min: 2, max: 8 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        size: fc.integer({ min: 1, max: 8 }),
        pairs: fc.uniqueArray(
          fc
            .tuple(fc.integer({ min: 1, max: n }), fc.integer({ min: 1, max: n }))
            .filter(([a, b]) => a !== b),
          { maxLength: 2 * n, selector: ([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}` },
        ),
        bothSides: fc.boolean(),
      }),
    );
    await fc.assert(
      fc.asyncProperty(cases, async ({ n, size, pairs, bothSides }) => {
        const w = world({ maxBatchSize: size });
        const say = (a: number, b: number) =>
          w.unsettled.set(change(a), [...(w.unsettled.get(change(a)) ?? []), change(b)]);
        for (const [a, b] of pairs) {
          say(a, b);
          if (bothSides) say(b, a);
        }
        const batches = await Effect.runPromise(
          Effect.gen(function* () {
            const base = yield* w.seeded;
            for (let i = 1; i <= n; i++) yield* queue(w, change(i));
            return yield* landAll(w, base, n);
          }).pipe(Effect.provide(w.layer)),
        );
        const apart = pairs.every(([a, b]) =>
          batches.every((batch) => !(batch.includes(change(a)) && batch.includes(change(b)))),
        );
        const once =
          batches.flat().toSorted().join() ===
          Array.from({ length: n }, (_, i) => change(i + 1)).join();
        const bounded = batches.every((batch) => batch.length >= 1 && batch.length <= size);
        // Each batch leads with the earliest change not yet batched: the queue's head.
        const headFirst = batches.every(
          (batch, i) => batch[0] === batches.slice(i).flat().toSorted()[0],
        );
        expect({ apart, once, bounded, headFirst }).toEqual({
          apart: true,
          once: true,
          bounded: true,
          headFirst: true,
        });
      }),
      fcRuns,
    );
    // By hand: 1 and 2 share a conflict, so 1 and 3 go together and 2 waits for the next batch.
    const w = world({ maxBatchSize: 3 });
    w.unsettled.set(change(2), [change(1)]);
    const batches = await Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* w.seeded;
        for (const n of [1, 2, 3]) yield* queue(w, change(n));
        return yield* landAll(w, base, 3);
      }).pipe(Effect.provide(w.layer)),
    );
    expect(batches).toEqual([[change(1), change(3)], [change(2)]]);
  }, 120_000);

  it.effect(
    "[c41.unattributed-alone] a batch of four that fails with no one blamed is split into four batches of one, each formed alone under the id its bisection named: the culprit bounces on its own verdict and the other three land",
    () => {
      const w = world({ maxBatchSize: 4 });
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const four = [1, 2, 3, 4].map(change);
        for (const id of four) yield* queue(w, id);
        const v = yield* toVerifying(w);
        yield* recordVerdict(LANE, verdict(v.batchId, v.candidateId, v.instanceId, "bounce"));
        expect((yield* payloads("BatchFailed")).at(-1)?.["attribution"]).toBe("unattributed");
        const into = (yield* payloads("CandidateBisected")).at(-1)?.["into"];
        expect(Array.isArray(into) && into.length).toBe(4);
        expect(laneOf(yield* EntityStore, LANE)?.active).toBeUndefined();
        // Each member's DO requeues it for the bisection, to the queue's front, in whatever order they arrive.
        for (const id of four.toReversed()) yield* requeuedFor(id, v.batchId, "bisection");
        const outcomes: (readonly [readonly ChangeId[], BatchId])[] = [];
        const blamed: unknown[] = [];
        let from = base;
        for (let round = 1; round <= four.length; round++) {
          const each = yield* toVerifying(w);
          const members = yield* membersInFlight;
          outcomes.push([members, each.batchId]);
          const culprit = members.includes(change(3));
          yield* recordVerdict(
            LANE,
            verdict(each.batchId, each.candidateId, each.instanceId, culprit ? "bounce" : "land"),
          );
          if (culprit) blamed.push((yield* payloads("BatchFailed")).at(-1)?.["attribution"]);
          else {
            yield* advance(from, head(round), members);
            from = head(round);
          }
        }
        expect(outcomes.map(([members]) => members)).toEqual(four.map((id) => [id]));
        expect(outcomes.map(([, batchId]) => batchId)).toEqual(
          Array.isArray(into) ? four.map((_, i) => into[i]) : [],
        );
        expect(blamed).toEqual([change(3)]);
        // The lane follows the last advance in its next step.
        yield* laneStep(LANE);
        expect((yield* payloads("CandidatePromoted")).length).toBe(3);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[c41.infra-several] a batch of two failing on the infrastructure counts it for both; at the limit each runs alone next, and its next such failure bounces it with every reason",
    () => {
      const w = world({ maxBatchSize: 2 });
      return Effect.gen(function* () {
        yield* w.seeded;
        const two = [1, 2].map(change);
        for (const id of two) yield* queue(w, id);
        for (let round = 0; round < INFRA_ROUNDS; round++) {
          const v = yield* toVerifying(w);
          expect(yield* membersInFlight).toEqual(two);
          yield* recordVerdict(LANE, verdict(v.batchId, v.candidateId, v.instanceId, "park"));
          expect((yield* payloads("BatchFailed")).at(-1)?.["attribution"]).toBe("infra");
          for (const id of two.toReversed()) yield* requeuedFor(id, v.batchId, "infra-failure");
        }
        const alone = yield* toVerifying(w);
        expect(yield* membersInFlight).toEqual([change(1)]);
        yield* recordVerdict(
          LANE,
          verdict(alone.batchId, alone.candidateId, alone.instanceId, "park"),
        );
        expect((yield* payloads("BatchFailed")).at(-1)?.["attribution"]).toBe(change(1));
        expect(String((yield* payloads("VerdictIssued")).at(-1)?.["evidence"])).toContain(
          `infra-failure x${INFRA_ROUNDS + 1}`,
        );
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[c41.runs-alone] a change requeued after its members clashed runs alone, and the batch formed behind another head leaves it out",
    () => {
      const w = world({ maxBatchSize: 4 });
      return Effect.gen(function* () {
        yield* w.seeded;
        for (const n of [1, 2, 3, 4]) yield* queue(w, change(n));
        const v = yield* toVerifying(w);
        yield* recordVerdict(LANE, verdict(v.batchId, v.candidateId, v.instanceId, "park"));
        // Their DOs requeue them to the front: 2 after a clash of its members, the rest after the infra failure.
        for (const n of [4, 3]) yield* requeuedFor(change(n), v.batchId, "infra-failure");
        yield* requeuedFor(change(2), v.batchId, "textual");
        yield* requeuedFor(change(1), v.batchId, "infra-failure");
        yield* toVerifying(w);
        expect(yield* membersInFlight).toEqual([1, 3, 4].map(change));
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[c41.outcomes] a bounce of a sole member is a failure the lane's next batch size reads, and a landing passes every member",
    () => {
      const w = world({ maxBatchSize: 8 });
      return Effect.gen(function* () {
        yield* w.seeded;
        yield* queue(w, change(1));
        const v = yield* toVerifying(w);
        yield* recordVerdict(LANE, verdict(v.batchId, v.candidateId, v.instanceId, "bounce"));
        expect(laneOf(yield* EntityStore, LANE)?.outcomes).toEqual(["fail"]);
        for (const n of [2, 3, 4, 5, 6, 7]) yield* queue(w, change(n));
        yield* toVerifying(w);
        // One failure in twenty: batchSize(0.05) is 4.
        expect(yield* membersInFlight).toEqual([2, 3, 4, 5].map(change));
      }).pipe(Effect.provide(w.layer));
    },
  );
});
