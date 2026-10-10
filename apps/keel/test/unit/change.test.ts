import { describe, expect, it } from "@effect/vitest";
import {
  abandon,
  adopt,
  changeWorkspace,
  declare,
  getChange,
  lapseLease,
  planCompiled,
  precheckStarted,
  revise,
  submit,
} from "@keeltown/core/application/coordination";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { ChangeId, CommitSha, makeId } from "@keeltown/core/kernel";
import { CodeHost, EventOutbox } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeManualClock,
  makeWorkspacePoolMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import {
  AbandonCommand,
  AdoptCommand,
  DeclareCommand,
  PlanCompiledCommand,
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
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeIdsMemory().layer,
    clock.layer,
    pool.layer,
    code.layer,
  );
  return { clock, pool, layer };
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
          projectId: sampleProjectId,
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
            agentId,
            authority: { _tag: "Lease", leaseId: declared.change.lease.id },
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
          Schema.decodeUnknownSync(AdoptCommand)({ agentId: adopterId, idempotencyKey: "adopt-1" }),
        );
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
        Schema.decodeUnknownSync(AdoptCommand)({ agentId: adopterId, idempotencyKey: "adopt-1" }),
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
          Schema.decodeUnknownSync(AdoptCommand)({ agentId: adopterId, idempotencyKey: "a" }),
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
      const stale = yield* Effect.exit(
        planCompiled(
          changeId,
          Schema.decodeUnknownSync(PlanCompiledCommand)({
            revision: 2,
            instanceId: "precheck-1",
            planHash: `sha256:${"0".repeat(64)}`,
            steps: 1,
            costEstimate: 1,
          }),
        ),
      );
      const compiled = yield* planCompiled(
        changeId,
        Schema.decodeUnknownSync(PlanCompiledCommand)({
          revision: 1,
          instanceId: "precheck-1",
          planHash: `sha256:${"0".repeat(64)}`,
          steps: 1,
          costEstimate: 1,
        }),
      );

      expect(first.state).toBe("deriving");
      expect(replayed).toEqual(first);
      expect(failureTag(stale)).toContain("ChangeStateRefused");
      expect(compiled.state).toBe("verifying");
      expect((yield* types).filter((type) => type === "PrecheckStarted")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});

describe("reading a change", () => {
  it.effect("answers ChangeNotFound for a change never declared", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.exit(getChange(makeId("chg", "01JZ8PT2C4E6G8J0M2N4Q6S8V9")));
      expect(failureTag(missing)).toContain("ChangeNotFound");
    }).pipe(Effect.provide(changeObject().layer)),
  );
});
