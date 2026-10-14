import { describe, expect, it } from "@effect/vitest";
import {
  abandon,
  adopt,
  changeRead,
  changeWorkspace,
  declare,
  getChange,
  lapseLease,
  planCompiled,
  precheckRefused,
  precheckStarted,
  escalationIdOf,
  reactToBatch,
  RELY_READS,
  rely,
  revise,
  submissionStatus,
  submit,
} from "@keeltown/core/application/coordination";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import {
  ChangeId,
  CommitSha,
  ConflictId,
  type EntityRef,
  EventEnvelope,
  makeId,
} from "@keeltown/core/kernel";
import {
  Clock,
  CodeHost,
  type Decisions,
  EntityStore,
  EventOutbox,
  LiveChanges,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeDecisionsMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import { ulid } from "ulid";
import {
  AbandonCommand,
  AdoptCommand,
  DeclareCommand,
  PlanCompiledCommand,
  PrecheckRefusedCommand,
  PrecheckStartedCommand,
  RelyCommand,
  ReviseCommand,
  SubmitCommand,
} from "../../src/rpc/index.ts";

const changeId = Schema.decodeUnknownSync(ChangeId)("chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const agentId = "agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const adopterId = "agt_01JZ8PT2C4E6G8J0M2N4Q6S8V1";
const BASE = CommitSha.make("b".repeat(40));

/** One Change DO's state, in memory, on a clock the test moves, with a pool and a code host. */
function changeObject(options: { readonly capacity?: number } = {}) {
  const clock = makeManualClock();
  const pool = makeWorkspacePoolMemory({ baseSha: BASE, ...options });
  const code = makeCodeHostMemory();
  const live = makeLiveChangesMemory();
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeIdsMemory().layer,
    clock.layer,
    pool.layer,
    code.layer,
    live.layer,
    makeDecisionsMemory().layer,
  );
  return { clock, pool, live, layer };
}

const declaring = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(DeclareCommand)({
    changeId,
    agentId,
    projectId: sampleProjectId,
    goal: "Cache permission lookups per request",
    footprint: [{ path: "src/authz/**", op: "edit" }],
    premises: [],
    idempotencyKey: "declare-1",
    fingerprint: "body-1",
    ...overrides,
  });

const revising = (leaseId: string, ifMatchRevision: number, key: string) =>
  Schema.decodeUnknownSync(ReviseCommand)({
    agentId,
    leaseId,
    ifMatchRevision,
    goal: `Revision after ${ifMatchRevision}`,
    premisesAdded: [],
    premisesRetracted: [],
    idempotencyKey: key,
  });

const submitting = (leaseId: string, commitSha: string, key: string) =>
  Schema.decodeUnknownSync(SubmitCommand)({ agentId, leaseId, commitSha, idempotencyKey: key });

/** Pushes a commit to the change's workspace, as the agent would. */
const pushToWorkspace = Effect.gen(function* () {
  const held = yield* changeWorkspace(changeId);
  yield* (yield* CodeHost).create(held.repo);
  return yield* (yield* CodeHostFixture).commit(held.repo, "refs/heads/main", { "a.txt": "a" });
});

const starting = (revision: number, instanceId: string) =>
  Schema.decodeUnknownSync(PrecheckStartedCommand)({ revision, instanceId });

const compiling = (revision: number, instanceId: string) =>
  Schema.decodeUnknownSync(PlanCompiledCommand)({
    revision,
    instanceId,
    planHash: `sha256:${"0".repeat(64)}`,
    steps: 1,
    costEstimate: 1,
  });

const refusing = (revision: number, instanceId: string) =>
  Schema.decodeUnknownSync(PrecheckRefusedCommand)({
    revision,
    instanceId,
    reasons: ["precheck:guard:.keel/guards/x"],
    nextActions: [
      {
        kind: "call",
        title: "Move the change off the guard paths, then submit it again",
        operationId: "submit",
      },
    ],
  });

const types = Effect.map(EventOutbox, (outbox) =>
  outbox.log({ kind: "change", id: changeId }).map((event) => event.type),
);

const failureTag = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded";

describe("declare", () => {
  it.effect(
    "[b11.declare-working] [b11.base-sha] leaves the change Working on its granted workspace and base, in one commit",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const held = yield* changeWorkspace(changeId);
        const outbox = yield* EventOutbox;

        expect(declared.change.state).toBe("working");
        expect(declared.change.baseSha).toBe(BASE);
        expect(declared.change.workspaceId).toBe(declared.grant.workspaceId);
        expect(held).toEqual({
          workspaceId: declared.grant.workspaceId,
          repo: declared.grant.repo,
          baseSha: BASE,
          grantedSha: BASE,
          projectId: sampleProjectId,
          subjects: [],
          intent: declared.change.intent,
        });
        expect(yield* types).toEqual(["IntentDeclared", "PreflightIssued", "ChangeStarted"]);
        expect(outbox.subscribers("ChangeSubmitted")).toEqual(
          expect.arrayContaining([`agent:${agentId}`, "workflow:Precheck"]),
        );
        expect(outbox.subscribers("ChangeWithdrawn")).toEqual(
          expect.arrayContaining([`agent:${agentId}`, `pool:${sampleProjectId}`]),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("[b11.declare-working] lets the agent submit straight after declaring", () => {
    const { layer } = changeObject();
    return Effect.gen(function* () {
      const declared = yield* declare(declaring());
      const sha = yield* pushToWorkspace;
      const submitted = yield* submit(
        changeId,
        submitting(declared.change.lease.id, sha, "submit-1"),
      );
      expect(submitted.state).toBe("submitted");
      expect(submitted.commitSha).toBe(sha);
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers a retried declare with the same change, committing nothing new", () => {
    const { layer } = changeObject();
    return Effect.gen(function* () {
      const first = yield* declare(declaring());
      const retried = yield* declare(declaring());
      const reused = yield* Effect.exit(declare(declaring({ fingerprint: "body-2" })));

      expect(retried.change).toEqual(first.change);
      expect(retried.grant.workspaceId).toBe(first.grant.workspaceId);
      expect(yield* types).toHaveLength(3);
      expect(failureTag(reused)).toContain("IdempotencyConflict");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "[b11.declare-release] releases a refused declare's grant as withdrawn, but never the workspace a live change holds, and an ended change asks for none",
    () => {
      const { layer, pool } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const again = yield* Effect.exit(declare(declaring({ idempotencyKey: "declare-2" })));
        expect(failureTag(again)).toContain("ChangeStateRefused");
        expect(pool.released.size).toBe(0);

        // The pool no longer counts the change as the holder (as when the change ends while the
        // grant is asked), so the refused declare is granted a workspace the change does not hold.
        pool.granted.delete(declared.grant.workspaceId);
        const unheld = yield* Effect.exit(declare(declaring({ idempotencyKey: "declare-3" })));
        expect(failureTag(unheld)).toContain("ChangeStateRefused");
        expect([...pool.released]).toEqual([[expect.any(String), "withdrawn"]]);
        expect(pool.released.has(declared.grant.workspaceId)).toBe(false);

        yield* abandon(
          changeId,
          Schema.decodeUnknownSync(AbandonCommand)({
            authority: { _tag: "Lease", leaseId: declared.change.lease.id, agentId },
            idempotencyKey: "abandon-1",
          }),
        );
        const afterEnd = yield* Effect.exit(declare(declaring({ idempotencyKey: "declare-4" })));
        expect(failureTag(afterEnd)).toContain("ChangeStateRefused");
        expect(pool.granted.size).toBe(0);
        expect(pool.released.size).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[change.abandon-maintainer] a maintainer withdraws a change of their project, named as the event's by and actor; another project's is ChangeNotFound and commits nothing",
    () => {
      const { layer } = changeObject();
      const maintainer = "usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
      const withdrawing = (projectId: string, key: string) =>
        Schema.decodeUnknownSync(AbandonCommand)({
          authority: { _tag: "Maintainer", by: maintainer, projectId },
          idempotencyKey: key,
        });
      return Effect.gen(function* () {
        yield* declare(declaring());
        const before = yield* types;
        const elsewhere = yield* Effect.exit(
          abandon(changeId, withdrawing(makeId("prj", ulid()), "abandon-elsewhere")),
        );
        expect(failureTag(elsewhere)).toContain("ChangeNotFound");
        expect(yield* types).toEqual(before);

        const withdrawn = yield* abandon(changeId, withdrawing(sampleProjectId, "abandon-1"));
        expect(withdrawn.state).toBe("withdrawn");
        const log = (yield* EventOutbox).log({ kind: "change", id: changeId });
        expect(log.at(-1)).toMatchObject({
          type: "ChangeWithdrawn",
          actor: `user:${maintainer}`,
          payload: { by: maintainer },
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("takes nothing when the pool is exhausted", () => {
    const { layer } = changeObject({ capacity: 0 });
    return Effect.gen(function* () {
      const exhausted = yield* Effect.exit(declare(declaring()));
      expect(failureTag(exhausted)).toContain("PoolExhausted");
      expect(failureTag(yield* Effect.exit(getChange(changeId)))).toContain("ChangeNotFound");
    }).pipe(Effect.provide(layer));
  });
});

describe("leases", () => {
  it.effect(
    "[b11.stale-lease] refuses the old token after adoption, with next actions, and authorises the new one",
    () => {
      const { layer, clock } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const oldLease = declared.change.lease.id;
        clock.advance(LEASE_TTL_MS);
        const lapsed = yield* Effect.exit(revise(changeId, revising(oldLease, 1, "revise-1")));
        const adopted = yield* adopt(
          changeId,
          Schema.decodeUnknownSync(AdoptCommand)({
            agentId: adopterId,
            projectId: sampleProjectId,
            idempotencyKey: "adopt-1",
          }),
        ).pipe(Effect.map((answer) => answer.change));
        const stale = yield* Effect.exit(revise(changeId, revising(oldLease, 1, "revise-2")));
        const fresh = yield* revise(changeId, revising(adopted.lease.id, 1, "revise-3"));

        expect(failureTag(lapsed)).toContain('"reason":"lapsed"');
        expect(adopted.lease.id).not.toBe(oldLease);
        expect(adopted.agentId).toBe(adopterId);
        expect(Exit.isFailure(stale) && JSON.stringify(stale.cause)).toContain("LeaseStale");
        expect(failureTag(stale)).toContain('"reason":"stale"');
        expect(failureTag(stale)).toContain("nextActions");
        expect(fresh.change.intent.revision).toBe(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("moves the subscription to the adopter, after telling both agents", () => {
    const { layer, clock } = changeObject();
    return Effect.gen(function* () {
      yield* declare(declaring());
      clock.advance(LEASE_TTL_MS);
      yield* adopt(
        changeId,
        Schema.decodeUnknownSync(AdoptCommand)({
          agentId: adopterId,
          projectId: sampleProjectId,
          idempotencyKey: "adopt-1",
        }),
      );
      const outbox = yield* EventOutbox;
      const adoption = outbox.log({ kind: "change", id: changeId }).at(-1);

      expect(adoption?.type).toBe("ChangeAdopted");
      expect(adoption?.notified).toEqual(
        expect.arrayContaining([`agent:${agentId}`, `agent:${adopterId}`]),
      );
      expect(adoption?.payload).toMatchObject({ briefRef: `change:${changeId}@r1` });
      expect(outbox.subscribers("ChangeBounced")).toContain(`agent:${adopterId}`);
      expect(outbox.subscribers("ChangeBounced")).not.toContain(`agent:${agentId}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an adoption while the lease is alive", () => {
    const { layer } = changeObject();
    return Effect.gen(function* () {
      yield* declare(declaring());
      const early = yield* Effect.exit(
        adopt(
          changeId,
          Schema.decodeUnknownSync(AdoptCommand)({
            agentId: adopterId,
            projectId: sampleProjectId,
            idempotencyKey: "a",
          }),
        ),
      );
      expect(failureTag(early)).toContain("LeaseNotLapsed");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "[b11.lapse] renews on every authorised call, and parks an agent-owned change only once 15 minutes pass unrenewed",
    () => {
      const { layer, clock } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const lease = declared.change.lease.id;
        clock.advance(LEASE_TTL_MS - 1);
        const revised = yield* revise(changeId, revising(lease, 1, "revise-1"));
        clock.advance(LEASE_TTL_MS - 1);
        const early = yield* lapseLease(changeId, lease, "early");
        clock.advance(1);
        const parked = yield* lapseLease(changeId, lease, "due");

        expect(revised.change.lease.renewedAt).toBe(clock.now() - LEASE_TTL_MS);
        expect(early.state).toBe("working");
        expect(early.lease.state).toBe("active");
        expect(parked.state).toBe("parked");
        expect(parked.parkReason).toBe("lease-lapsed");
        expect((yield* types).slice(-2)).toEqual(["LeaseLapsed", "ChangeParked"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b11.lapse] parks a change whose lease lapsed while the platform held it at its next agent-owned transition",
    () => {
      const { layer, clock } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const sha = yield* pushToWorkspace;
        yield* submit(changeId, submitting(declared.change.lease.id, sha, "submit-1"));
        yield* precheckStarted(
          changeId,
          Schema.decodeUnknownSync(PrecheckStartedCommand)({ revision: 1, instanceId: "p-1" }),
        );
        clock.advance(LEASE_TTL_MS);
        const platformOwned = yield* lapseLease(changeId, declared.change.lease.id, "due");

        expect(platformOwned.state).toBe("deriving");
        expect(platformOwned.lease.state).toBe("lapsed");
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("submit", () => {
  it.effect("refuses a commit that is not in the change's workspace", () => {
    const { layer } = changeObject();
    return Effect.gen(function* () {
      const declared = yield* declare(declaring());
      yield* pushToWorkspace;
      const elsewhere = yield* Effect.exit(
        submit(changeId, submitting(declared.change.lease.id, "c".repeat(40), "submit-1")),
      );
      expect(failureTag(elsewhere)).toContain("CommitNotInWorkspace");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a reused Idempotency-Key with another body", () => {
    const { layer } = changeObject();
    return Effect.gen(function* () {
      const declared = yield* declare(declaring());
      const sha = yield* pushToWorkspace;
      const lease = declared.change.lease.id;
      yield* submit(changeId, submitting(lease, sha, "submit-1"));
      const retried = yield* submit(changeId, submitting(lease, sha, "submit-1"));
      const reused = yield* Effect.exit(revise(changeId, revising(lease, 1, "submit-1")));

      expect(retried.state).toBe("submitted");
      expect(failureTag(reused)).toContain("IdempotencyConflict");
    }).pipe(Effect.provide(layer));
  });
});

describe("Precheck's commands", () => {
  it.effect("[b11.precheck-idem] commit once per instance, and refuse a stale revision", () => {
    const { layer } = changeObject();
    return Effect.gen(function* () {
      const declared = yield* declare(declaring());
      const sha = yield* pushToWorkspace;
      yield* submit(changeId, submitting(declared.change.lease.id, sha, "submit-1"));
      const started = Schema.decodeUnknownSync(PrecheckStartedCommand)({
        revision: 1,
        instanceId: "precheck-1",
      });
      const first = yield* precheckStarted(changeId, started);
      const replayed = yield* precheckStarted(changeId, started);
      const stale = yield* Effect.exit(planCompiled(changeId, compiling(2, "precheck-1")));
      const compiled = yield* planCompiled(changeId, compiling(1, "precheck-1"));

      expect(first.state).toBe("deriving");
      expect(replayed).toEqual(first);
      expect(failureTag(stale)).toContain("ChangeStateRefused");
      expect(compiled.state).toBe("queued");
      expect((yield* types).filter((type) => type === "PrecheckStarted")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});

/** Declares, pushes, submits and starts Precheck instance `instanceId`, leaving the change Deriving. */
const deriving = (instanceId: string) =>
  Effect.gen(function* () {
    const declared = yield* declare(declaring());
    const sha = yield* pushToWorkspace;
    yield* submit(changeId, submitting(declared.change.lease.id, sha, "submit-1"));
    yield* precheckStarted(changeId, starting(1, instanceId));
    return { lease: declared.change.lease.id, sha };
  });

describe("a compiled plan", () => {
  it.effect(
    "[b13.queued] queues the change on its project's lane in the plan's commit, and subscribes the lane to its queueing, requeues and ends",
    () => {
      const { layer } = changeObject();
      const lane = `lane:${sampleProjectId}:main`;
      return Effect.gen(function* () {
        yield* deriving("precheck-1");
        const compiled = yield* planCompiled(changeId, compiling(1, "precheck-1"));
        const replayed = yield* planCompiled(changeId, compiling(1, "precheck-1"));
        const outbox = yield* EventOutbox;
        const log = outbox.log({ kind: "change", id: changeId });
        const [plan, queued] = log.slice(-2);

        expect(compiled).toMatchObject({ state: "queued", laneId: lane });
        expect(replayed).toEqual(compiled);
        expect([plan?.type, queued?.type]).toEqual(["PlanCompiled", "ChangeQueued"]);
        // The enqueue carries the plan it was compiled to.
        expect(queued?.payload).toEqual({
          _tag: "ChangeQueued",
          changeId,
          laneId: lane,
          planHash: Reflect.get(Object(plan?.payload), "planHash"),
        });
        expect(queued?.dedupeKey.split("/")[1]).toBe(plan?.dedupeKey.split("/")[1]);
        expect(queued?.notified).toContain(lane);
        for (const type of [
          "ChangeQueued",
          "ChangeRequeued",
          "ChangeWithdrawn",
          "ChangeSuperseded",
        ])
          expect(outbox.subscribers(type)).toContain(lane);
        expect(log.filter((event) => event.type === "ChangeQueued")).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );
});

const changeRef: EntityRef = { kind: "change", id: changeId };
const otherChange = Schema.decodeUnknownSync(ChangeId)("chg_01JZ8PT2C4E6G8J0M2N4Q6S8V9");
const VERDICT = makeId("vrd", "01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const CANDIDATE = makeId("cnd", "01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const freshBatch = () => makeId("bat", ulid());

/** An event another object committed about the change, as its outbox delivers it. */
const arriving = (entity: EntityRef, payload: Record<string, unknown>) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type: payload["_tag"],
    entity,
    seq: 1,
    at: 0,
    dedupeKey: `${entity.kind}:${entity.id}/cause-${ulid()}/${String(payload["_tag"])}#1`,
    affected: [changeRef],
    notified: [`change:${changeId}`],
    payload,
  });

const formed = (batchId: string, members: readonly string[]) =>
  arriving(
    { kind: "batch", id: batchId },
    {
      _tag: "BatchFormed",
      batchId,
      laneId: `lane:${sampleProjectId}:main`,
      members,
      base: BASE,
      attempt: 1,
      chainEpoch: 0,
    },
  );
const verdictOn = (batchId: string, evidence: readonly string[], extra: object = {}) =>
  arriving(
    { kind: "verdict", id: VERDICT },
    {
      _tag: "VerdictIssued",
      verdictId: VERDICT,
      subject: batchId,
      outcome: "bounce",
      evidence,
      ...extra,
    },
  );
const failed = (batchId: string, attribution: string) =>
  arriving(
    { kind: "batch", id: batchId },
    { _tag: "BatchFailed", batchId, verdictId: VERDICT, attribution },
  );
const bisected = (batchId: string) =>
  arriving(
    { kind: "candidate", id: CANDIDATE },
    { _tag: "CandidateBisected", candidateId: CANDIDATE, batchId, into: [] },
  );
const invalidated = (batchId: string) =>
  arriving(
    { kind: "candidate", id: CANDIDATE },
    { _tag: "CandidateInvalidated", candidateId: CANDIDATE, batchId, reason: "head-moved" },
  );
const TRUNK_TO = CommitSha.make("d".repeat(40));
/** One member's landing: its commit on trunk, its batch's candidate and proof. */
const landing = (member: string, commitSha: string, candidateId: string, proofId: string) => ({
  changeId: member,
  commitSha,
  candidateId,
  proofId,
});
const advanced = (landings: readonly ReturnType<typeof landing>[]) =>
  arriving(
    { kind: "trunk", id: sampleProjectId },
    {
      _tag: "TrunkAdvanced",
      projectId: sampleProjectId,
      from: BASE,
      to: TRUNK_TO,
      groupId: "group-1",
      landings,
      height: 1,
    },
  );

/** Receives `event` as the Change DO does: recorded, reacted to and the reaction's events appended, in one transaction. */
const receive = (event: EventEnvelope) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    const at = yield* (yield* Clock).now;
    return store.transaction(() => {
      if (!outbox.receive(event.dedupeKey, at)) return undefined;
      const reaction = reactToBatch(changeId, event, { store, outbox, at });
      if (reaction !== undefined && reaction.drafts.length > 0)
        outbox.append(
          {
            entity: changeRef,
            cause: event.dedupeKey,
            causation: event.eventId,
            ...(reaction.project === undefined ? {} : { project: reaction.project }),
          },
          at,
          reaction.drafts,
        );
      return reaction;
    });
  });

/** Declares, submits and compiles the change's plan, leaving it Queued on its lane. */
const queued = Effect.gen(function* () {
  yield* deriving("precheck-1");
  yield* planCompiled(changeId, compiling(1, "precheck-1"));
});

/** Queues the change, then forms a batch of it. */
const batched = Effect.gen(function* () {
  yield* queued;
  const batchId = freshBatch();
  yield* receive(formed(batchId, [changeId]));
  return batchId;
});

const lastEvent = Effect.map(EventOutbox, (outbox) => outbox.log(changeRef).at(-1));

describe("the change's batch, delivered", () => {
  it.effect(
    "[b13.reacts] batches the change when a BatchFormed names it, once, and ignores one that does not",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* queued;
        yield* receive(formed(freshBatch(), [otherChange]));
        const untouched = yield* getChange(changeId);
        const batchId = freshBatch();
        const formation = formed(batchId, [changeId, otherChange]);
        yield* receive(formation);
        yield* receive(formation);
        const log = (yield* EventOutbox).log(changeRef);

        expect(untouched.state).toBe("queued");
        expect(yield* getChange(changeId)).toMatchObject({ state: "integrating", batchId });
        expect(log.filter((event) => event.type === "ChangeBatched")).toHaveLength(1);
        expect(log.at(-1)).toMatchObject({
          type: "ChangeBatched",
          causation: formation.eventId,
          project: sampleProjectId,
        });
        expect(log.at(-1)?.actor).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b13.reacts] bounces the change on a failure attributed to it, with its verdict's reasons and next actions",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        const batchId = yield* batched;
        const remedy = {
          kind: "call",
          title: "Revise the change onto trunk, then submit it again",
          operationId: "revise",
        };
        yield* receive(
          verdictOn(batchId, ["composition-refused: conflict src/a.ts"], { nextActions: [remedy] }),
        );
        yield* receive(failed(batchId, changeId));

        expect((yield* getChange(changeId)).state).toBe("bounced");
        expect((yield* lastEvent)?.payload).toEqual({
          _tag: "ChangeBounced",
          changeId,
          verdictId: VERDICT,
          reasons: ["composition-refused: conflict src/a.ts"],
          nextActions: [remedy],
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b13.counterparts] bounces the change with what its verdict says it conflicts with on trunk",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        const batchId = yield* batched;
        const counterparts = [
          { commitSha: "c".repeat(40), paths: ["src/a.ts"] },
          {
            changeId: "chg_01J9C000000000000000000091",
            commitSha: "d".repeat(40),
            paths: ["src/a.ts"],
          },
        ];
        yield* receive(
          verdictOn(batchId, ["composition-refused: conflict src/a.ts"], { counterparts }),
        );
        yield* receive(failed(batchId, changeId));

        expect((yield* getChange(changeId)).state).toBe("bounced");
        expect((yield* lastEvent)?.payload).toMatchObject({
          _tag: "ChangeBounced",
          verdictId: VERDICT,
          counterparts,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b13.reacts] falls back to the machine's next action when the verdict names none, and to the verdict's id when it was never heard",
    () => {
      const first = changeObject();
      const second = changeObject();
      return Effect.gen(function* () {
        const withoutActions = yield* Effect.gen(function* () {
          const batchId = yield* batched;
          yield* receive(verdictOn(batchId, ["test-failed: auth.test.ts"]));
          yield* receive(failed(batchId, changeId));
          return yield* lastEvent;
        }).pipe(Effect.provide(first.layer));
        const unheard = yield* Effect.gen(function* () {
          const batchId = yield* batched;
          const reaction = yield* receive(failed(batchId, changeId));
          return { reaction, bounced: yield* lastEvent };
        }).pipe(Effect.provide(second.layer));

        expect(withoutActions?.payload).toMatchObject({
          reasons: ["test-failed: auth.test.ts"],
          nextActions: [{ kind: "call", operationId: "submit" }],
        });
        expect(unheard.bounced?.payload).toMatchObject({ reasons: [`verdict ${VERDICT}`] });
        expect(unheard.reaction?.problem).toContain(VERDICT);
      });
    },
  );

  it.effect(
    "[b13.reacts] [c41.red-exit] requeues the change with its cause on an infra failure, another member's failure, a clash of its members, a bisection or an invalidation of its batch",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* queued;
        const reasons: unknown[] = [];
        for (const requeueing of [
          (batchId: string) => failed(batchId, "infra"),
          (batchId: string) => failed(batchId, otherChange),
          (batchId: string) => failed(batchId, "textual"),
          (batchId: string) => failed(batchId, "interaction"),
          bisected,
          invalidated,
        ]) {
          const batchId = freshBatch();
          yield* receive(formed(batchId, [changeId]));
          yield* receive(requeueing(batchId));
          const change = yield* getChange(changeId);
          expect(change.state).toBe("queued");
          expect(change.batchId).toBeUndefined();
          reasons.push(Reflect.get(Object((yield* lastEvent)?.payload), "reason"));
        }
        expect(reasons).toEqual([
          "infra-failure",
          "co-member-failed",
          "textual",
          "interaction",
          "bisection",
          "invalidated",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b13.reacts] [c41.red-exit] waits for the bisection on a failure no one is blamed for, and does nothing for another batch's events",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        const batchId = yield* batched;
        const before = (yield* EventOutbox).log(changeRef).length;
        const elsewhere = freshBatch();
        for (const event of [
          failed(batchId, "unattributed"),
          verdictOn(elsewhere, ["not ours"]),
          failed(elsewhere, changeId),
          bisected(elsewhere),
          invalidated(elsewhere),
        ])
          yield* receive(event);

        expect(yield* getChange(changeId)).toMatchObject({ state: "integrating", batchId });
        expect((yield* EventOutbox).log(changeRef)).toHaveLength(before);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("the change's trunk, delivered", () => {
  it.effect(
    "[b13.reacts] lands the change from its own landing, once, and ignores an advance that does not name it",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* batched;
        const before = (yield* EventOutbox).log(changeRef).length;
        const otherCandidate = makeId("cnd", ulid());
        yield* receive(advanced([landing(otherChange, "1".repeat(40), otherCandidate, "prf-o")]));
        const untouched = yield* getChange(changeId);
        const advance = advanced([
          landing(otherChange, "1".repeat(40), otherCandidate, "prf-o"),
          landing(changeId, "2".repeat(40), CANDIDATE, "prf-c"),
        ]);
        yield* receive(advance);
        yield* receive(advance);
        const log = (yield* EventOutbox).log(changeRef);

        expect(untouched.state).toBe("integrating");
        expect(yield* getChange(changeId)).toMatchObject({ state: "landed" });
        expect(log.slice(before).map((event) => event.type)).toEqual(["ChangeLanded"]);
        expect(log.at(-1)).toMatchObject({
          causation: advance.eventId,
          project: sampleProjectId,
          payload: {
            _tag: "ChangeLanded",
            changeId,
            commitSha: "2".repeat(40),
            trunkSha: TRUNK_TO,
            candidateId: CANDIDATE,
            proofId: "prf-c",
          },
        });
        expect(log.at(-1)?.actor).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b13.reacts] commits nothing and reports a problem when an advance lands a change that is not integrating",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* queued;
        const before = (yield* EventOutbox).log(changeRef).length;
        const reaction = yield* receive(
          advanced([landing(changeId, "2".repeat(40), CANDIDATE, "prf-c")]),
        );

        expect(reaction?.problem).toBe(
          "TrunkAdvanced refused with ChangeStateRefused in state queued",
        );
        expect((yield* getChange(changeId)).state).toBe("queued");
        expect((yield* EventOutbox).log(changeRef)).toHaveLength(before);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("a Precheck refusal", () => {
  it.effect(
    "[b11.precheck-refused] issues a ruling verdict on its own entity and bounces the change naming it, in one commit",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* deriving("precheck-1");
        const refusal = refusing(1, "precheck-1");
        const answered = yield* precheckRefused(changeId, refusal);
        const replayed = yield* precheckRefused(changeId, refusal);
        const outbox = yield* EventOutbox;
        const verdict = outbox.log({ kind: "verdict", id: answered.verdictId });
        const bounced = outbox.log({ kind: "change", id: changeId }).at(-1);

        expect(answered.change.state).toBe("bounced");
        expect(replayed.verdictId).toBe(answered.verdictId);
        expect(verdict.map((event) => [event.type, event.seq])).toEqual([["VerdictIssued", 1]]);
        expect(verdict[0]?.payload).toEqual({
          _tag: "VerdictIssued",
          verdictId: answered.verdictId,
          subject: changeId,
          outcome: "bounce",
          evidence: ["precheck:guard:.keel/guards/x"],
        });
        expect(bounced?.type).toBe("ChangeBounced");
        expect(bounced?.payload).toMatchObject({
          verdictId: answered.verdictId,
          reasons: ["precheck:guard:.keel/guards/x"],
          nextActions: refusal.nextActions,
        });
        expect(bounced?.dedupeKey.split("/")[1]).toBe(verdict[0]?.dedupeKey.split("/")[1]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b11.precheck-idem] starts a resubmission's own Precheck, while the bounced one's replay commits nothing",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        const { lease, sha } = yield* deriving("precheck-1");
        yield* precheckRefused(changeId, refusing(1, "precheck-1"));
        yield* revise(changeId, revising(lease, 1, "revise-1"));
        yield* submit(changeId, submitting(lease, sha, "submit-2"));
        const second = yield* precheckStarted(changeId, starting(2, "precheck-2"));
        const firstReplayed = yield* Effect.exit(
          precheckStarted(changeId, starting(1, "precheck-1")),
        );

        expect(second.state).toBe("deriving");
        expect((yield* types).filter((type) => type === "PrecheckStarted")).toHaveLength(2);
        expect(Exit.isSuccess(firstReplayed)).toBe(true);
        expect((yield* types).filter((type) => type === "PrecheckStarted")).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("reading a change", () => {
  it.effect("answers ChangeNotFound for a change never declared", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.exit(getChange(makeId("chg", "01JZ8PT2C4E6G8J0M2N4Q6S8V9")));
      expect(failureTag(missing)).toContain("ChangeNotFound");
    }).pipe(Effect.provide(changeObject().layer)),
  );
});

describe("the remedy a status read carries", () => {
  it.effect(
    "[b11.remedy-of] keeps the bounce's reasons and next actions verbatim through a lapse, and clears them on resubmission",
    () => {
      const { layer, clock } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const lease = declared.change.lease.id;
        const sha = yield* pushToWorkspace;
        yield* submit(changeId, submitting(lease, sha, "submit-1"));
        yield* precheckStarted(changeId, starting(1, "p-1"));
        yield* precheckRefused(changeId, refusing(1, "p-1"));
        const bounced = yield* submissionStatus(changeId);
        clock.advance(LEASE_TTL_MS);
        yield* lapseLease(changeId, lease, "due");
        const parked = yield* submissionStatus(changeId);
        const adopted = yield* adopt(
          changeId,
          Schema.decodeUnknownSync(AdoptCommand)({
            agentId: adopterId,
            projectId: sampleProjectId,
            idempotencyKey: "adopt-1",
          }),
        );
        yield* submit(changeId, submitting(adopted.change.lease.id, sha, "submit-2"));
        const resubmitted = yield* submissionStatus(changeId);

        const asked = refusing(1, "p-1");
        expect(bounced.change.state).toBe("bounced");
        expect(bounced.remedy).toMatchObject({
          reasons: asked.reasons,
          nextActions: asked.nextActions,
        });
        expect(parked.change).toMatchObject({ state: "parked", parkReason: "lease-lapsed" });
        expect(parked.remedy).toEqual(bounced.remedy);
        expect(resubmitted.change.state).toBe("submitted");
        expect(resubmitted.remedy).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );
});

const CONFLICT = makeId("cfl", "01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const OTHER_CONFLICT = makeId("cfl", "01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const DECISION = makeId("dec", "01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const OTHER_DECISION = makeId("dec", "01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const escalated = (conflictId: string) =>
  arriving(
    { kind: "conflict", id: conflictId },
    {
      _tag: "ConflictEscalated",
      conflictId,
      escalationId: escalationIdOf(Schema.decodeUnknownSync(ConflictId)(conflictId)),
      reason: "human-class",
    },
  );
const resolved = (conflictId: string, decisionId?: string, against?: readonly string[]) =>
  arriving(
    { kind: "conflict", id: conflictId },
    {
      _tag: "ConflictResolved",
      conflictId,
      move: "escalate",
      ...(decisionId === undefined ? {} : { decisionId }),
      ...(against === undefined ? {} : { against }),
    },
  );
const RELIED = {
  subject: "authz.session",
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
};
/** The two sides of a conflict as a party hears it open: who relies on the premise, and who makes the effect. */
interface Sides {
  readonly holder: string;
  readonly author: string;
}
const suspected = (conflictId: string, { holder, author }: Sides) =>
  arriving(
    { kind: "conflict", id: conflictId },
    {
      _tag: "ConflictSuspected",
      conflictId,
      kind: "semantic",
      parties: [holder, author],
      premise: { holder, proposition: RELIED },
      effect: { changeId: author, proposition: RELIED },
    },
  );
/**
 * A change parked for the ruling on CONFLICT, in a world of its own, after it
 * hears that conflict resolved against `against`: the ruling, what the change
 * made of it, the change and its last event. `sides` is the conflict as it
 * heard it open; without them it never heard it open.
 */
const afterRuling = (against: readonly string[], sides?: Sides) =>
  Effect.gen(function* () {
    yield* queued;
    if (sides !== undefined) yield* receive(suspected(CONFLICT, sides));
    yield* receive(escalated(CONFLICT));
    const ruling = resolved(CONFLICT, DECISION, against);
    const reaction = yield* receive(ruling);
    return { ruling, reaction, change: yield* getChange(changeId), last: yield* lastEvent };
  }).pipe(Effect.provide(changeObject().layer));
const REVISE_OR_WITHDRAW = [
  expect.objectContaining({ operationId: "revise" }),
  expect.objectContaining({ operationId: "abandon" }),
];
const typesOf = Effect.map(EventOutbox, (outbox) => outbox.log(changeRef).map((e) => e.type));

describe("a conflict of the change put to a person", () => {
  it.effect(
    "[t35.park-resume] parks a queued party, keeping its lane and plan, and resumes it into the queue on that escalation's decision and on no other",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* queued;
        const before = yield* getChange(changeId);
        const asked = escalated(CONFLICT);
        const parking = yield* receive(asked);
        yield* receive(asked);
        const parked = yield* getChange(changeId);
        // Another conflict's decision, and a resolution with no decision, are not what it waits for.
        const others = yield* receive(resolved(OTHER_CONFLICT, DECISION));
        yield* receive(resolved(CONFLICT));
        const waiting = yield* getChange(changeId);
        const ruling = resolved(CONFLICT, DECISION);
        yield* receive(ruling);
        const resumed = yield* getChange(changeId);
        const log = (yield* EventOutbox).log(changeRef);

        expect(parking?.problem).toBeUndefined();
        expect(parked).toMatchObject({
          state: "parked",
          parkReason: "awaiting-ruling",
          parkedFrom: "queued",
          escalationId: escalationIdOf(CONFLICT),
          laneId: before.laneId,
          planHash: before.planHash,
        });
        expect(waiting.state).toBe("parked");
        // The machine would hold such a resume back; the party does not ask for one, so nothing is reported.
        expect(others?.problem).toBeUndefined();
        expect(resumed.state).toBe("queued");
        expect(resumed).toMatchObject({ laneId: before.laneId, planHash: before.planHash });
        expect([resumed.parkReason, resumed.escalationId, resumed.parkedFrom]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
        expect(log.map((e) => e.type).slice(-2)).toEqual(["ChangeParked", "ChangeResumed"]);
        expect(log.at(-2)).toMatchObject({
          causation: asked.eventId,
          project: sampleProjectId,
          payload: { reason: "awaiting-ruling", escalationId: escalationIdOf(CONFLICT) },
        });
        expect(log.at(-1)).toMatchObject({
          causation: ruling.eventId,
          payload: { decisionId: DECISION },
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[t35.ruling-bounces] a party parked for a ruling that goes against it is bounced by the decision, told what the ruling means for it and to revise or withdraw; the party it favours resumes",
    () =>
      Effect.gen(function* () {
        const making: Sides = { holder: otherChange, author: changeId };
        const relying: Sides = { holder: changeId, author: otherChange };
        const premiseHeld = yield* afterRuling([changeId], making);
        const effectStood = yield* afterRuling([changeId], relying);
        const unsided = yield* afterRuling([changeId]);
        const favoured = yield* afterRuling([otherChange], relying);

        for (const { ruling, reaction, change, last } of [premiseHeld, effectStood, unsided]) {
          expect(reaction?.problem).toBeUndefined();
          expect(change.state).toBe("bounced");
          expect([change.parkReason, change.escalationId, change.parkedFrom]).toEqual([
            undefined,
            undefined,
            undefined,
          ]);
          expect(last).toMatchObject({
            type: "ChangeBounced",
            causation: ruling.eventId,
            project: sampleProjectId,
            payload: { changeId, decisionId: DECISION, nextActions: REVISE_OR_WITHDRAW },
          });
        }
        // The reason is the consequence of the option the ruling chose, as the person read it.
        expect(premiseHeld.last?.payload).toMatchObject({
          reasons: [
            `${changeId} must change so that it no longer contradicts it; ${otherChange} goes on as declared.`,
          ],
        });
        expect(effectStood.last?.payload).toMatchObject({
          reasons: [
            `${changeId} must stop relying on the premise; ${otherChange} goes on as declared.`,
          ],
        });
        // A conflict the change never heard open still says which decision, on which conflict.
        expect(unsided.last?.payload).toMatchObject({
          reasons: [expect.stringMatching(new RegExp(`^${DECISION} .* ${CONFLICT}\\.$`))],
        });
        expect(favoured.reaction?.problem).toBeUndefined();
        expect(favoured.change.state).toBe("queued");
        expect(favoured.last).toMatchObject({
          type: "ChangeResumed",
          causation: favoured.ruling.eventId,
          payload: { decisionId: DECISION },
        });
      }),
  );

  it.effect(
    "[t35.ruling-bounces] a ruling against a party on a conflict it is not waiting for takes it out of the wait all the same, and a later ruling against it, back with its agent, moves nothing and reports nothing",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* queued;
        yield* receive(escalated(CONFLICT));
        yield* receive(escalated(OTHER_CONFLICT));
        const waiting = yield* getChange(changeId);
        const against = resolved(OTHER_CONFLICT, OTHER_DECISION, [changeId]);
        yield* receive(against);
        const bounced = yield* getChange(changeId);
        const last = yield* lastEvent;
        const later = yield* receive(resolved(CONFLICT, DECISION, [changeId]));

        expect(waiting.escalationId).toBe(escalationIdOf(CONFLICT));
        expect(bounced.state).toBe("bounced");
        expect(last).toMatchObject({
          type: "ChangeBounced",
          causation: against.eventId,
          payload: { decisionId: OTHER_DECISION, nextActions: REVISE_OR_WITHDRAW },
        });
        expect([later?.problem, later?.drafts]).toEqual([undefined, []]);
        expect((yield* getChange(changeId)).state).toBe("bounced");
        expect(yield* lastEvent).toEqual(last);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[t35.ruling-bounces] a party already in a batch when the ruling goes against it is not bounced and finishes its batch, and that is reported by the decision, the change, the conflict and the state",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* batched;
        yield* receive(escalated(CONFLICT));
        const reaction = yield* receive(resolved(CONFLICT, DECISION, [changeId]));

        expect(reaction?.problem).toBe(
          `${DECISION} ruled against ${changeId} on ${CONFLICT} and its bounce was refused in state integrating: it may land as it is`,
        );
        expect(reaction?.drafts).toEqual([]);
        expect((yield* getChange(changeId)).state).toBe("integrating");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[t35.park-on-queue] a change whose conflict went to a person while it derived is parked in the commit that queues it, and one with none is queued and left there",
    () => {
      const asked = changeObject();
      const free = changeObject();
      return Effect.gen(function* () {
        yield* deriving("precheck-1");
        const early = yield* receive(escalated(CONFLICT));
        const stillDeriving = (yield* getChange(changeId)).state;
        yield* planCompiled(changeId, compiling(1, "precheck-1"));
        const parked = yield* getChange(changeId);
        const committed = (yield* typesOf).slice(-3);
        yield* receive(resolved(CONFLICT, DECISION));
        const resumed = (yield* getChange(changeId)).state;
        const unasked = yield* Effect.gen(function* () {
          yield* queued;
          return [(yield* getChange(changeId)).state, (yield* typesOf).at(-1)];
        }).pipe(Effect.provide(free.layer));

        // Where the machine parks nothing the change goes on as it was, and that is no problem.
        expect([early?.problem, stillDeriving]).toEqual([undefined, "deriving"]);
        expect(committed).toEqual(["PlanCompiled", "ChangeQueued", "ChangeParked"]);
        expect(parked).toMatchObject({
          state: "parked",
          parkedFrom: "queued",
          escalationId: escalationIdOf(CONFLICT),
        });
        expect(resumed).toBe("queued");
        expect(unasked).toEqual(["queued", "ChangeQueued"]);
      }).pipe(Effect.provide(asked.layer));
    },
  );

  it.effect(
    "[t35.park-resume] a party already in a batch is not parked: it finishes its batch, and nothing is reported",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* batched;
        const reaction = yield* receive(escalated(CONFLICT));
        expect(reaction?.problem).toBeUndefined();
        expect(reaction?.drafts).toEqual([]);
        expect((yield* getChange(changeId)).state).toBe("integrating");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[t35.park-after-resume] a party with two conflicts before a person is not resumed by the first ruling: it stays parked, from then under the other's escalation, and the second ruling leaves it queued",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* queued;
        const before = yield* getChange(changeId);
        yield* receive(escalated(CONFLICT));
        yield* receive(escalated(OTHER_CONFLICT));
        const waiting = yield* getChange(changeId);
        const first = resolved(CONFLICT, DECISION);
        const reaction = yield* receive(first);
        const held = yield* getChange(changeId);
        const again = (yield* EventOutbox).log(changeRef).slice(-2);
        const second = resolved(OTHER_CONFLICT, OTHER_DECISION);
        yield* receive(second);
        const free = yield* getChange(changeId);
        const last = yield* lastEvent;

        // The second escalation parks nothing more: the change already waits for the first.
        expect(waiting.escalationId).toBe(escalationIdOf(CONFLICT));
        expect(reaction?.problem).toBeUndefined();
        // The machine refuses the resume while the other is open, so the first ruling commits one park and no resume.
        expect(again.map((e) => e.type)).toEqual(["ChangeParked", "ChangeParked"]);
        expect(again[0]?.payload).toMatchObject({ escalationId: escalationIdOf(CONFLICT) });
        expect(again[1]?.causation).toBe(first.eventId);
        // Under the escalation still open, never the one just ruled on.
        expect(again[1]?.payload).toMatchObject({
          reason: "awaiting-ruling",
          escalationId: escalationIdOf(OTHER_CONFLICT),
        });
        expect(held).toMatchObject({
          state: "parked",
          parkReason: "awaiting-ruling",
          parkedFrom: "queued",
          escalationId: escalationIdOf(OTHER_CONFLICT),
          laneId: before.laneId,
          planHash: before.planHash,
        });
        expect(free.state).toBe("queued");
        expect(free.escalationId).toBeUndefined();
        expect(last).toMatchObject({
          type: "ChangeResumed",
          causation: second.eventId,
          payload: { decisionId: OTHER_DECISION },
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[t35.park-after-requeue] a party whose conflict went to a person while it was in a batch is parked in the commit that requeues it, whatever requeued it, and requeued with nothing before a person it is left in the queue",
    () =>
      Effect.forEach(
        [(batchId: string) => failed(batchId, "infra"), bisected, invalidated],
        (requeueing) => {
          const { layer } = changeObject();
          return Effect.gen(function* () {
            const batchId = yield* batched;
            yield* receive(escalated(CONFLICT));
            const inBatch = yield* getChange(changeId);
            const requeue = requeueing(batchId);
            const reaction = yield* receive(requeue);
            const held = yield* getChange(changeId);
            const committed = (yield* EventOutbox).log(changeRef).slice(-2);
            yield* receive(resolved(CONFLICT, DECISION));
            const resumed = yield* getChange(changeId);
            // Nothing is before a person now: the next requeue leaves it in the queue.
            const next = freshBatch();
            yield* receive(formed(next, [changeId]));
            yield* receive(requeueing(next));
            const free = yield* getChange(changeId);
            const last = yield* lastEvent;

            expect(inBatch.state).toBe("integrating");
            expect(reaction?.problem).toBeUndefined();
            expect(committed.map((e) => e.type)).toEqual(["ChangeRequeued", "ChangeParked"]);
            expect(committed.map((e) => e.causation)).toEqual([requeue.eventId, requeue.eventId]);
            expect(committed[1]?.payload).toMatchObject({
              reason: "awaiting-ruling",
              escalationId: escalationIdOf(CONFLICT),
            });
            expect(held).toMatchObject({
              state: "parked",
              parkedFrom: "queued",
              escalationId: escalationIdOf(CONFLICT),
              planHash: inBatch.planHash,
            });
            expect(held.batchId).toBeUndefined();
            expect(resumed.state).toBe("queued");
            expect(free.state).toBe("queued");
            expect(last?.type).toBe("ChangeRequeued");
          }).pipe(Effect.provide(layer));
        },
      ),
  );
});

describe("the run an agent's command names", () => {
  const RUN = { id: "run_01JZ8PT2C4E6G8J0M2N4Q6S8V0", label: "run-c" };
  const OTHER = { id: "run_01JZ8PT2C4E6G8J0M2N4Q6S8V1", label: "run-b" };

  /** Each event on the change, as who caused it and under which run. */
  const caused = Effect.map(EventOutbox, (outbox) =>
    outbox.log(changeRef).map((event) => ({
      type: event.type,
      actor: event.actor,
      run: event.run,
    })),
  );

  it.effect(
    "[run.commands] declare, revise, rely, submit and a withdrawal under the lease each name their run on every event they commit, and the platform's events name none",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring({ run: RUN }));
        const leaseId = declared.change.lease.id;
        expect(declared.change.run).toEqual(RUN);
        yield* revise(
          changeId,
          Schema.decodeUnknownSync(ReviseCommand)({
            agentId,
            run: RUN,
            leaseId,
            ifMatchRevision: 1,
            goal: "Revised by the same run",
            premisesAdded: [],
            premisesRetracted: [],
            idempotencyKey: "revise-1",
          }),
        );
        yield* rely(
          changeId,
          Schema.decodeUnknownSync(RelyCommand)({
            agentId,
            run: RUN,
            leaseId,
            premise: {
              subject: "migrate",
              predicate: "ordering",
              relation: "before",
              value: "deploy",
            },
            idempotencyKey: "rely-1",
          }),
        );
        const sha = yield* pushToWorkspace;
        yield* submit(
          changeId,
          Schema.decodeUnknownSync(SubmitCommand)({
            agentId,
            run: RUN,
            leaseId,
            commitSha: sha,
            idempotencyKey: "submit-1",
          }),
        );
        yield* abandon(
          changeId,
          Schema.decodeUnknownSync(AbandonCommand)({
            authority: { _tag: "Lease", leaseId, agentId, run: RUN },
            idempotencyKey: "abandon-1",
          }),
        );
        const events = yield* caused;
        const agents = events.filter((event) => event.actor === `agent:${agentId}`);
        expect(new Set(agents.map((event) => event.type))).toEqual(
          new Set([
            "IntentDeclared",
            "PreflightIssued",
            "ChangeStarted",
            "IntentRevised",
            "ChangeSubmitted",
            "ChangeWithdrawn",
          ]),
        );
        // The revision and the rely each commit an IntentRevised of the agent's.
        expect(agents.filter((event) => event.type === "IntentRevised")).toHaveLength(2);
        expect(agents.filter((event) => event.run?.label !== "run-c")).toEqual([]);
        expect(agents.every((event) => event.run?.id === RUN.id)).toBe(true);
        expect(
          events.filter((event) => event.actor === undefined && event.run !== undefined),
        ).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[run.commands] a command of no run names none, and an adopted change is held by the adopter's run from its adoption on",
    () => {
      const { layer, clock } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        expect("run" in declared.change).toBe(false);
        clock.advance(LEASE_TTL_MS);
        const adopted = yield* adopt(
          changeId,
          Schema.decodeUnknownSync(AdoptCommand)({
            agentId: adopterId,
            run: OTHER,
            projectId: sampleProjectId,
            idempotencyKey: "adopt-1",
          }),
        ).pipe(Effect.map((answer) => answer.change));
        expect(adopted.run).toEqual(OTHER);
        const events = yield* caused;
        expect(
          events.filter((event) => event.actor === `agent:${agentId}`).map((event) => event.run),
        ).toEqual([undefined, undefined, undefined]);
        const adoption = events.filter((event) => event.type === "ChangeAdopted");
        expect(adoption).toMatchObject([{ actor: `agent:${adopterId}`, run: OTHER }]);
        expect((yield* getChange(changeId)).run).toEqual(OTHER);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("the conflicts a change's batch keeps apart", () => {
  it.effect(
    "[c41.unsettled] a change's read names each other change it shares a conflict with, on either side, until that conflict is dismissed or resolved",
    () => {
      const { layer } = changeObject();
      const third = Schema.decodeUnknownSync(ChangeId)("chg_01JZ8PT2C4E6G8J0M2N4Q6S8VA");
      const unsettled = Effect.map(changeRead(changeId), (read) => read.unsettled);
      return Effect.gen(function* () {
        yield* queued;
        expect(yield* unsettled).toEqual([]);
        yield* receive(suspected(CONFLICT, { holder: changeId, author: otherChange }));
        yield* receive(suspected(OTHER_CONFLICT, { holder: third, author: changeId }));
        expect(yield* unsettled).toEqual([otherChange, third].toSorted());
        // With a person, a conflict is still unsettled.
        yield* receive(escalated(CONFLICT));
        expect(yield* unsettled).toEqual([otherChange, third].toSorted());
        yield* receive(resolved(CONFLICT));
        expect(yield* unsettled).toEqual([third]);
        yield* receive(
          arriving(
            { kind: "conflict", id: OTHER_CONFLICT },
            { _tag: "ConflictDismissed", conflictId: OTHER_CONFLICT, reason: "probe-refuted" },
          ),
        );
        expect(yield* unsettled).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("a rely racing a revise", () => {
  it.effect(
    "[t694.rely-race] a rely whose change is revised while it reads what is near reads again for the intent it then leaves, and commits on that read",
    () => {
      const clock = makeManualClock();
      const memory = makeLiveChangesMemory();
      const asked: { readonly goal: string; readonly premises: number }[] = [];
      /** Runs once, inside the first near read: what another request commits meanwhile. */
      const meanwhile: { run: (() => void) | undefined } = { run: undefined };
      const live = Layer.effect(
        LiveChanges,
        Effect.map(LiveChanges, (inner) =>
          LiveChanges.of({
            near: (projectId, self, intent) =>
              Effect.suspend(() => {
                asked.push({ goal: intent.goal, premises: intent.premises.length });
                const run = meanwhile.run;
                meanwhile.run = undefined;
                run?.();
                return inner.near(projectId, self, intent);
              }),
          }),
        ),
      ).pipe(Layer.provide(memory.layer));
      const layer = Layer.mergeAll(
        makeEventOutboxMemory().layer,
        makeIdsMemory().layer,
        clock.layer,
        makeWorkspacePoolMemory({ baseSha: BASE }).layer,
        makeCodeHostMemory().layer,
        live,
        makeDecisionsMemory().layer,
      );
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const leaseId = declared.change.lease.id;
        const services = yield* Effect.context<
          Clock | EntityStore | EventOutbox | LiveChanges | Decisions
        >();
        meanwhile.run = () =>
          Effect.runSync(
            revise(changeId, revising(leaseId, 1, "revise-meanwhile")).pipe(
              Effect.provide(services),
            ),
          );
        asked.length = 0;
        const relied = yield* rely(
          changeId,
          Schema.decodeUnknownSync(RelyCommand)({
            agentId,
            leaseId,
            premise: {
              subject: "migrate",
              predicate: "ordering",
              relation: "before",
              value: "deploy",
            },
            idempotencyKey: "rely-1",
          }),
        );
        // The rely read first, the revise read for itself, then the rely read again for the revised intent.
        expect(asked).toEqual([
          { goal: "Cache permission lookups per request", premises: 1 },
          { goal: "Revision after 1", premises: 0 },
          { goal: "Revision after 1", premises: 1 },
        ]);
        expect(relied.change.intent).toMatchObject({ revision: 3, goal: "Revision after 1" });
        expect(RELY_READS).toBeGreaterThan(1);
      }).pipe(Effect.provide(layer));
    },
  );
});
