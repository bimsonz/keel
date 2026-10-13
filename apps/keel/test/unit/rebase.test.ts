// rebase on one Change DO's state in memory: the change's workspace is a
// fork of its project's trunk at the grant, trunk then moves on, and a rebase
// puts trunk's head on the workspace's keel/trunk and moves the change's base
// there. The domain decides first, so a refused rebase pushes nothing.
import { describe, expect, it } from "@effect/vitest";
import {
  CHANGE_WORKSPACE,
  changeWorkspace,
  declare,
  precheckRefused,
  precheckStarted,
  rebase,
  submit,
} from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { AgentId, ChangeId, type CommitSha, LeaseId, RunRef } from "@keeltown/core/kernel";
import { PushRejected } from "@keeltown/core/domain/integration";
import {
  CodeHost,
  EntityStore,
  EventOutbox,
  KEEL_TRUNK_REF,
  PackTooLarge,
} from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeManualClock,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  makeWorkspaceRebaserMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import {
  DeclareCommand,
  PrecheckRefusedCommand,
  PrecheckStartedCommand,
  SubmitCommand,
} from "../../src/rpc/index.ts";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { rebaseError } from "../../src/adapters/driving/http/work-loop.ts";

const changeId = Schema.decodeUnknownSync(ChangeId)("chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const MAIN = "refs/heads/main";
const repos = projectRepos(sampleProjectId);

/**
 * A Change DO's state beside its project's trunk: `base` is trunk's head at
 * the grant, `landed` the head trunk moved to since, which the Trunk DO
 * reports. The mirror still holds `base`, as a lagging mirror would.
 */
function world() {
  const clock = makeManualClock();
  const code = makeCodeHostMemory();
  const trunks = makeTrunksMemory();
  const rebaser = makeWorkspaceRebaserMemory(code);
  const seeded = Effect.gen(function* () {
    const host = yield* CodeHost;
    yield* host.create(repos.trunk);
    const base = yield* code.fixture.commit(repos.trunk, MAIN, { "README.md": "base\n" });
    yield* host.fork(repos.trunk, repos.mirror);
    const landed = yield* code.fixture.commit(repos.trunk, MAIN, { "README.md": "landed\n" });
    trunks.heads.set(sampleProjectId, landed);
    return { base, landed };
  }).pipe(Effect.provide(code.layer));
  const layerFor = (base: CommitSha) =>
    Layer.mergeAll(
      makeEventOutboxMemory().layer,
      makeIdsMemory().layer,
      clock.layer,
      makeWorkspacePoolMemory({ baseSha: base }).layer,
      code.layer,
      trunks.layer,
      rebaser.layer,
      makeLiveChangesMemory().layer,
    );
  return { clock, code, rebaser, seeded, layerFor };
}

const declaring = Schema.decodeUnknownSync(DeclareCommand)({
  changeId,
  agentId,
  projectId: sampleProjectId,
  goal: "Rebase after a textual bounce",
  footprint: [{ path: "src/**", op: "edit" }],
  premises: [],
  idempotencyKey: "declare-1",
  fingerprint: "body-1",
});

/** Declares the change and forks its workspace from the mirror, at the grant's base, as the pool does. */
const declared = Effect.gen(function* () {
  const { change } = yield* declare(declaring);
  const held = yield* changeWorkspace(changeId);
  yield* (yield* CodeHost).fork(repos.mirror, held.repo);
  return { lease: change.lease.id, held };
});

const rebasing = (leaseId: LeaseId, idempotencyKey = "rebase-1") => ({
  agentId,
  leaseId,
  idempotencyKey,
});

const rebasedEvents = Effect.map(EventOutbox, (outbox) =>
  outbox.log({ kind: "change", id: changeId }).filter((e) => e.type === "ChangeRebased"),
);

describe("rebase", () => {
  it.effect(
    "[rebase.moves-base] puts trunk's head on the workspace's keel/trunk and moves the change's base there; the view serves the new base and the grant",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { base, landed } = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease, held } = yield* declared;
          const rebased = yield* rebase(changeId, rebasing(lease));
          expect(rebased).toMatchObject({ ref: KEEL_TRUNK_REF, base: landed });
          expect(rebased.change).toMatchObject({ state: "working", baseSha: landed });
          expect(yield* (yield* CodeHost).head(held.repo, KEEL_TRUNK_REF)).toBe(landed);
          expect(yield* (yield* CodeHost).head(held.repo, MAIN)).toBe(base);
          expect((yield* rebasedEvents).map((e) => e.payload)).toEqual([
            { _tag: "ChangeRebased", changeId, from: base, to: landed },
          ]);
          expect(yield* changeWorkspace(changeId)).toMatchObject({
            baseSha: landed,
            grantedSha: base,
          });
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[run.commands] a rebase names its run on the ChangeRebased it commits, as the agent's own",
    () => {
      const w = world();
      const lane = Schema.decodeUnknownSync(RunRef)({
        id: "run_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
        label: "run-c",
      });
      return Effect.gen(function* () {
        const { base } = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          yield* rebase(changeId, { ...rebasing(lease), run: lane });
          expect(
            (yield* rebasedEvents).map((event) => ({ actor: event.actor, run: event.run })),
          ).toStrictEqual([{ actor: `agent:${agentId}`, run: lane }]);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[rebase.held-stored] the grant's commit is stored under baseSha, as changes stored before rebases were, and read back as grantedSha",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { base } = yield* w.seeded;
        return yield* Effect.gen(function* () {
          yield* declared;
          const stored = (yield* EntityStore).get(CHANGE_WORKSPACE, changeId);
          expect(stored).toMatchObject({ baseSha: base });
          expect(stored).not.toHaveProperty("grantedSha");
          expect((yield* changeWorkspace(changeId)).grantedSha).toBe(base);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[rebase.head-from-trunk] rebases onto the head the Trunk DO reports, never the lagging mirror's",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { base, landed } = yield* w.seeded;
        expect(
          yield* Effect.provide(
            Effect.flatMap(CodeHost, (h) => h.head(repos.mirror, MAIN)),
            w.code.layer,
          ),
        ).toBe(base);
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          expect((yield* rebase(changeId, rebasing(lease))).base).toBe(landed);
          expect(w.rebaser.pushed.map((p) => p.to)).toEqual([landed]);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[rebase.decides-first] a rebase the domain refuses (a stale lease, a submitted change) pushes nothing and moves nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { base } = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease, held } = yield* declared;
          const stale = yield* Effect.exit(
            rebase(changeId, rebasing(LeaseId.make("lse_01JZ8PT2C4E6G8J0M2N4Q6S8V9"))),
          );
          expect(Exit.isFailure(stale) && JSON.stringify(stale.cause)).toContain("LeaseStale");

          const work = yield* w.code.fixture.commit(held.repo, MAIN, { "README.md": "work\n" });
          yield* submit(
            changeId,
            Schema.decodeUnknownSync(SubmitCommand)({
              agentId,
              leaseId: lease,
              commitSha: work,
              idempotencyKey: "submit-1",
            }),
          );
          const submitted = yield* Effect.exit(rebase(changeId, rebasing(lease, "rebase-2")));
          expect(Exit.isFailure(submitted) && JSON.stringify(submitted.cause)).toContain(
            "ChangeStateRefused",
          );
          expect(w.rebaser.pushed).toEqual([]);
          expect(yield* rebasedEvents).toEqual([]);
          expect(
            yield* Effect.flip((yield* CodeHost).head(held.repo, KEEL_TRUNK_REF)),
          ).toMatchObject({ _tag: "RefNotFound" });
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[rebase.bounced] a change Precheck bounced rebases, and stays Bounced on the new base until it is submitted again",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { base, landed } = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease, held } = yield* declared;
          const work = yield* w.code.fixture.commit(held.repo, MAIN, { "README.md": "work\n" });
          yield* submit(
            changeId,
            Schema.decodeUnknownSync(SubmitCommand)({
              agentId,
              leaseId: lease,
              commitSha: work,
              idempotencyKey: "submit-1",
            }),
          );
          yield* precheckStarted(
            changeId,
            Schema.decodeUnknownSync(PrecheckStartedCommand)({
              revision: 1,
              instanceId: "precheck-1",
            }),
          );
          yield* precheckRefused(
            changeId,
            Schema.decodeUnknownSync(PrecheckRefusedCommand)({
              revision: 1,
              instanceId: "precheck-1",
              reasons: ["precheck:not-descended"],
              nextActions: [{ kind: "call", title: "Rebase", operationId: "rebase" }],
            }),
          );
          const rebased = yield* rebase(changeId, rebasing(lease));
          expect(rebased.change).toMatchObject({ state: "bounced", baseSha: landed });
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[rebase.retry] a retried key answers as before and pushes nothing again; the key with another command is a conflict",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const { base, landed } = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const first = yield* rebase(changeId, rebasing(lease));
          w.clock.advance(LEASE_TTL_MS / 2);
          const again = yield* rebase(changeId, rebasing(lease));
          expect(again).toEqual({ ...first, change: again.change });
          expect(again.base).toBe(landed);
          expect(w.rebaser.pushed).toHaveLength(1);
          expect((yield* rebasedEvents).length).toBe(1);
          const reused = yield* Effect.flip(
            rebase(changeId, {
              ...rebasing(lease),
              agentId: AgentId.make("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V1"),
            }),
          );
          expect(reused._tag).toBe("IdempotencyConflict");
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );
});

describe("rebase over HTTP", () => {
  const caller: Caller = {
    requestId: "req-1",
    principal: { _tag: "Anonymous" },
    signal: new AbortController().signal,
  };

  it("[rebase.problems] a busy workspace is 503 workspace.busy with Retry-After and a rebase to retry; a pack over the cap is 409 with an escalation", () => {
    const busy = rebaseError(caller, new PushRejected({ reason: "busy" }));
    expect(busy).toMatchObject({
      status: 503,
      headers: { "retry-after": 5 },
      body: {
        code: "workspace.busy",
        nextActions: [expect.objectContaining({ kind: "call", operationId: "rebase" })],
      },
    });
    const tooLarge = rebaseError(
      caller,
      new PackTooLarge({ repo: { namespace: "keel-ws-00", name: "w" }, bytes: 70e6, limit: 60e6 }),
    );
    expect(tooLarge).toMatchObject({
      status: 409,
      body: { code: "workspace.pack_too_large", nextActions: [{ kind: "escalate" }] },
    });
  });
});
