import { describe, expect, it } from "@effect/vitest";
import {
  abandon,
  adopt,
  changeWorkspace,
  declare,
  getChange,
  lapseLease,
  planCompiled,
  precheckRefused,
  precheckStarted,
  reactToBatch,
  revise,
  submissionStatus,
  submit,
} from "@keeltown/core/application/coordination";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { ChangeId, CommitSha, type EntityRef, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { Clock, CodeHost, EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
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
    "[b11.declare-release] releases a refused declare's grant as withdrawn, but never the workspace a live change holds",
    () => {
      const { layer, pool } = changeObject();
      return Effect.gen(function* () {
        const declared = yield* declare(declaring());
        const again = yield* Effect.exit(declare(declaring({ idempotencyKey: "declare-2" })));
        expect(failureTag(again)).toContain("ChangeStateRefused");
        expect(pool.released.size).toBe(0);

        yield* abandon(
          changeId,
          Schema.decodeUnknownSync(AbandonCommand)({
            authority: { _tag: "Lease", leaseId: declared.change.lease.id, agentId },
            idempotencyKey: "abandon-1",
          }),
        );
        // The pool collects the withdrawn change's workspace by event; the direct release is for a refused declare.
        pool.granted.delete(declared.grant.workspaceId);
        const afterEnd = yield* Effect.exit(declare(declaring({ idempotencyKey: "declare-3" })));

        expect(failureTag(afterEnd)).toContain("ChangeStateRefused");
        expect([...pool.released]).toEqual([[expect.any(String), "withdrawn"]]);
        expect(pool.released.has(declared.grant.workspaceId)).toBe(false);
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
          actor: `operator:${maintainer}`,
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
    "[b13.reacts] requeues the change on an infra failure, a bisection or an invalidation of its batch",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        yield* queued;
        const reasons: unknown[] = [];
        for (const requeueing of [
          (batchId: string) => failed(batchId, "infra"),
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
        expect(reasons).toEqual(["infra-failure", "bisection", "invalidated"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b13.reacts] does nothing for another member's failure, an unattributed one, or another batch's events",
    () => {
      const { layer } = changeObject();
      return Effect.gen(function* () {
        const batchId = yield* batched;
        const before = (yield* EventOutbox).log(changeRef).length;
        const elsewhere = freshBatch();
        for (const event of [
          failed(batchId, otherChange),
          failed(batchId, "unattributed"),
          failed(batchId, "textual"),
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
