// commit on one Change DO's state in memory: the change's workspace is a fork
// of its project's trunk at the grant, and the agent's edits become one commit
// on its main through the writer. The lease and the state are checked first,
// so a refused commit writes nothing; a written one renews the lease.
import { describe, expect, it } from "@effect/vitest";
import {
  abandon,
  adopt,
  changeWorkspace,
  CommitParentRefused,
  commitEdits,
  declare,
  getChange,
  refreshWorkspace,
  submit,
} from "@keeltown/core/application/coordination";
import { projectRepos } from "@keeltown/core/application/integration";
import { AgentId, ChangeId, type CommitSha, LeaseId, ProjectId } from "@keeltown/core/kernel";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import {
  CodeHost,
  EventOutbox,
  EditsRefused,
  ObjectNotFound,
  PackTooLarge,
  WorkspaceHeadMoved,
  WorkspacePool,
} from "@keeltown/core/ports";
import {
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeIdsMemory,
  makeLiveChangesMemory,
  makeDecisionsMemory,
  makeManualClock,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  makeWorkspaceRebaserMemory,
  makeWorkspaceWriterMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Effect, Fiber, Layer, Result, Schema } from "effect";
import { DeclareCommand, SubmitCommand } from "../../src/rpc/index.ts";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { commitEditsError, commitInput } from "../../src/adapters/driving/http/work-loop.ts";

const changeId = Schema.decodeUnknownSync(ChangeId)("chg_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const otherAgent = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V2");
const otherProject = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V2");
const MAIN = "refs/heads/main";
const repos = projectRepos(sampleProjectId);
const text = (s: string) => new TextEncoder().encode(s);

/** A Change DO's state beside its project's trunk, whose head at the grant is `base`; `asked` names the holder of each grant the pool is asked for. */
function world() {
  const clock = makeManualClock();
  const code = makeCodeHostMemory();
  const writer = makeWorkspaceWriterMemory(code);
  const asked: string[] = [];
  const seeded = Effect.gen(function* () {
    const host = yield* CodeHost;
    yield* host.create(repos.trunk);
    const base = yield* code.fixture.commit(repos.trunk, MAIN, {
      "README.md": "base\n",
      "src/a.ts": "export const a = 1;\n",
    });
    yield* host.fork(repos.trunk, repos.mirror);
    return base;
  }).pipe(Effect.provide(code.layer));
  const layerFor = (base: CommitSha) =>
    Layer.mergeAll(
      makeEventOutboxMemory().layer,
      makeIdsMemory().layer,
      clock.layer,
      Layer.effect(
        WorkspacePool,
        Effect.map(WorkspacePool, (pool) =>
          WorkspacePool.of({
            ...pool,
            grant: (projectId, holder) => {
              asked.push(holder);
              return pool.grant(projectId, holder);
            },
          }),
        ),
      ).pipe(Layer.provide(makeWorkspacePoolMemory({ baseSha: base }).layer)),
      code.layer,
      makeTrunksMemory().layer,
      makeWorkspaceRebaserMemory(code).layer,
      writer.layer,
      makeLiveChangesMemory().layer,
      makeDecisionsMemory().layer,
    );
  return { clock, code, writer, asked, seeded, layerFor };
}

const declaring = Schema.decodeUnknownSync(DeclareCommand)({
  changeId,
  agentId,
  projectId: sampleProjectId,
  goal: "Commit with no clone",
  footprint: [{ path: "src/**", op: "edit" }],
  premises: [],
  idempotencyKey: "declare-1",
  fingerprint: "body-1",
});

/** Declares the change and forks its workspace from the mirror, at the grant's base, as the pool does. */
const declared = Effect.gen(function* () {
  const { change, grant: declaredGrant } = yield* declare(declaring);
  const held = yield* changeWorkspace(changeId);
  yield* (yield* CodeHost).fork(repos.mirror, held.repo);
  return { lease: change.lease.id, held, grant: declaredGrant };
});

const committing = (leaseId: LeaseId, expectedHead: CommitSha, idempotencyKey = "commit-1") => ({
  agentId,
  projectId: sampleProjectId,
  handle: "swarm-1",
  leaseId,
  expectedHead,
  edits: [{ path: "src/a.ts", content: text("export const a = 2;\n") }],
  message: "Raise a",
  idempotencyKey,
});

describe("commit", () => {
  it.effect(
    "[commit.writes] the edits land as one commit on the workspace's main, on the base, and the lease is renewed",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease, held } = yield* declared;
          w.clock.advance(60_000);
          const made = yield* commitEdits(changeId, committing(lease, base));
          expect(made.parent).toBe(base);
          expect(yield* (yield* CodeHost).head(held.repo, MAIN)).toBe(made.commit.commitSha);
          expect(w.writer.committed.map((c) => c.commit)).toEqual([made.commit.commitSha]);
          expect((yield* getChange(changeId)).lease.renewedAt).toBe(w.clock.now());
          expect(made.change.lease.renewedAt).toBe(w.clock.now());
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect("[commit.lease-first] a stale lease is refused before anything is written", () => {
    const w = world();
    return Effect.gen(function* () {
      const base = yield* w.seeded;
      return yield* Effect.gen(function* () {
        const { held } = yield* declared;
        const stale = Schema.decodeUnknownSync(LeaseId)("lse_01JZ8PT2C4E6G8J0M2N4Q6S8V9");
        const refused = yield* Effect.flip(commitEdits(changeId, committing(stale, base)));
        expect(refused).toMatchObject({ _tag: "LeaseStale" });
        expect(w.writer.committed).toEqual([]);
        expect(yield* (yield* CodeHost).head(held.repo, MAIN)).toBe(base);
      }).pipe(Effect.provide(w.layerFor(base)));
    });
  });

  it.effect(
    "[commit.state] once the change is submitted, a commit is refused and nothing is written",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const made = yield* commitEdits(changeId, committing(lease, base));
          yield* submit(
            changeId,
            Schema.decodeUnknownSync(SubmitCommand)({
              agentId,
              projectId: sampleProjectId,
              leaseId: lease,
              commitSha: made.commit.commitSha,
              idempotencyKey: "submit-1",
            }),
          );
          const again = yield* Effect.flip(
            commitEdits(changeId, committing(lease, made.commit.commitSha, "commit-2")),
          );
          expect(again).toMatchObject({ _tag: "ChangeStateRefused", command: "commit" });
          expect(w.writer.committed).toHaveLength(1);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.parent-bound] a parent other than the head read or the change's base is refused before anything is written; the base is allowed",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease, held } = yield* declared;
          const first = yield* commitEdits(changeId, committing(lease, base));
          const stray = yield* w.code.fixture.commit(held.repo, "refs/heads/elsewhere", {
            "other.md": "unrelated\n",
          });
          const head = first.commit.commitSha;
          const grafted = yield* Effect.flip(
            commitEdits(changeId, { ...committing(lease, head, "commit-2"), parent: stray }),
          );
          expect(grafted).toMatchObject({ _tag: "CommitParentRefused", parent: stray, base });
          expect(w.writer.committed).toHaveLength(1);
          const onBase = yield* commitEdits(changeId, {
            ...committing(lease, head, "commit-3"),
            parent: base,
            edits: [{ path: "src/a.ts", content: text("export const a = 3;\n") }],
          });
          expect(onBase.parent).toBe(base);
          expect(w.writer.committed).toHaveLength(2);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.head-moved] a workspace that moved is the writer's refusal, passed on, and the lease is renewed: the call held it",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const first = yield* commitEdits(changeId, committing(lease, base));
          const renewedAt = (yield* getChange(changeId)).lease.renewedAt;
          w.clock.advance(60_000);
          const moved = yield* Effect.flip(
            commitEdits(changeId, {
              ...committing(lease, base, "commit-2"),
              edits: [{ path: "src/b.ts", content: text("export const b = 1;\n") }],
            }),
          );
          expect(moved).toMatchObject({
            _tag: "WorkspaceHeadMoved",
            expected: base,
            head: first.commit.commitSha,
          });
          // Refused after the lease check, the call still renews the lease: its agent is at work.
          expect((yield* getChange(changeId)).lease.renewedAt).toBe(renewedAt + 60_000);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.own-agent] another agent, or the change's agent in another project, reads the change as not found and nothing is written",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const stranger = yield* Effect.flip(
            commitEdits(changeId, { ...committing(lease, base), agentId: otherAgent }),
          );
          expect(stranger).toMatchObject({ _tag: "ChangeNotFound", changeId });
          const elsewhere = yield* Effect.flip(
            commitEdits(changeId, {
              ...committing(lease, base, "commit-2"),
              projectId: otherProject,
            }),
          );
          expect(elsewhere).toMatchObject({ _tag: "ChangeNotFound", changeId });
          expect(w.writer.committed).toEqual([]);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.lease-before-state] a stale lease on a submitted change reads as the lease, as every leased command does",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const made = yield* commitEdits(changeId, committing(lease, base));
          yield* submit(
            changeId,
            Schema.decodeUnknownSync(SubmitCommand)({
              agentId,
              projectId: sampleProjectId,
              leaseId: lease,
              commitSha: made.commit.commitSha,
              idempotencyKey: "submit-1",
            }),
          );
          const stale = Schema.decodeUnknownSync(LeaseId)("lse_01JZ8PT2C4E6G8J0M2N4Q6S8V9");
          const refused = yield* Effect.flip(
            commitEdits(changeId, committing(stale, made.commit.commitSha, "commit-2")),
          );
          expect(refused).toMatchObject({ _tag: "LeaseStale" });
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.replay] a retry of a call that committed answers its commit, even once the workspace has moved on",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const first = yield* commitEdits(changeId, committing(lease, base));
          yield* commitEdits(changeId, {
            ...committing(lease, first.commit.commitSha, "commit-2"),
            edits: [{ path: "src/b.ts", content: text("export const b = 1;\n") }],
          });
          const retried = yield* commitEdits(changeId, committing(lease, base));
          expect(retried.commit).toEqual(first.commit);
          expect(retried.parent).toBe(base);
          expect(w.writer.committed).toHaveLength(2);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.key-reused] the same key with other edits is refused, and nothing is written",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const first = yield* commitEdits(changeId, committing(lease, base));
          const reused = yield* Effect.flip(
            commitEdits(changeId, {
              ...committing(lease, first.commit.commitSha),
              edits: [{ path: "src/b.ts", content: text("export const b = 1;\n") }],
            }),
          );
          expect(reused).toMatchObject({ _tag: "IdempotencyConflict", idempotencyKey: "commit-1" });
          expect(w.writer.committed).toHaveLength(1);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.decides-again] an abandon that lands while the writer pushes refuses the call, and no commit is recorded for its key",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const hold = w.writer.holdNext();
          const pushing = yield* Effect.forkChild(commitEdits(changeId, committing(lease, base)));
          yield* Effect.promise(() => hold.held);
          yield* abandon(changeId, {
            authority: { _tag: "Lease", leaseId: lease, agentId },
            idempotencyKey: "abandon-1",
          });
          hold.release();
          const answer = yield* Effect.flip(Fiber.join(pushing));
          expect(answer).toMatchObject({ _tag: "ChangeStateRefused", command: "commit" });
          const retried = yield* Effect.flip(commitEdits(changeId, committing(lease, base)));
          expect(retried).toMatchObject({ _tag: "ChangeStateRefused", command: "commit" });
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[commit.decides-again-adopted] an adoption that lands while the writer pushes refuses the old agent's call, and its lease is not renewed",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const hold = w.writer.holdNext();
          const pushing = yield* Effect.forkChild(commitEdits(changeId, committing(lease, base)));
          yield* Effect.promise(() => hold.held);
          w.clock.advance(LEASE_TTL_MS + 1);
          const adopted = yield* adopt(changeId, {
            agentId: otherAgent,
            projectId: sampleProjectId,
            idempotencyKey: "adopt-1",
          });
          hold.release();
          const answer = yield* Effect.flip(Fiber.join(pushing));
          expect(answer).toMatchObject({ _tag: "ChangeNotFound", changeId });
          const after = yield* getChange(changeId);
          expect(after.agentId).toBe(otherAgent);
          expect(after.lease).toEqual(adopted.change.lease);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );
});

const asking = (leaseId: LeaseId) => ({ agentId, projectId: sampleProjectId, leaseId });

describe("refresh", () => {
  const changeLog = Effect.map(EventOutbox, (outbox) =>
    outbox.log({ kind: "change", id: changeId }),
  );

  it.effect(
    "[workspace.refresh-same] the change's own agent gets the workspace it holds with a token of its own, and no event is committed",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease, held, grant } = yield* declared;
          const before = (yield* changeLog).length;
          const fresh = yield* refreshWorkspace(changeId, asking(lease));
          expect(fresh.workspaceId).toBe(held.workspaceId);
          expect(fresh.repo).toEqual(held.repo);
          expect(fresh.token).not.toBe(grant.token);
          expect((yield* changeLog).length).toBe(before);
          expect(w.asked).toEqual([changeId, changeId]);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[workspace.refresh-under-lease] a stale or lapsed lease is refused and the pool mints nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const stale = Schema.decodeUnknownSync(LeaseId)("lse_01JZ8PT2C4E6G8J0M2N4Q6S8V9");
          const refused = yield* Effect.flip(refreshWorkspace(changeId, asking(stale)));
          expect(refused).toMatchObject({ _tag: "LeaseStale", reason: "stale" });
          w.clock.advance(LEASE_TTL_MS + 1);
          const lapsed = yield* Effect.flip(refreshWorkspace(changeId, asking(lease)));
          expect(lapsed).toMatchObject({ _tag: "LeaseStale", reason: "lapsed" });
          expect(w.asked).toEqual([changeId]);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[workspace.refresh-own] another agent, or the change's agent in another project, reads the change as not found",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          const stranger = yield* Effect.flip(
            refreshWorkspace(changeId, { ...asking(lease), agentId: otherAgent }),
          );
          expect(stranger).toMatchObject({ _tag: "ChangeNotFound", changeId });
          const elsewhere = yield* Effect.flip(
            refreshWorkspace(changeId, { ...asking(lease), projectId: otherProject }),
          );
          expect(elsewhere).toMatchObject({ _tag: "ChangeNotFound", changeId });
          expect(w.asked).toEqual([changeId]);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );

  it.effect(
    "[workspace.refresh-ended] a withdrawn change is refused and the pool is never asked",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        return yield* Effect.gen(function* () {
          const { lease } = yield* declared;
          yield* abandon(changeId, {
            authority: { _tag: "Lease", leaseId: lease, agentId },
            idempotencyKey: "abandon-1",
          });
          const refused = yield* Effect.flip(refreshWorkspace(changeId, asking(lease)));
          expect(refused).toMatchObject({ _tag: "ChangeStateRefused", state: "withdrawn" });
          expect(w.asked).toEqual([changeId]);
        }).pipe(Effect.provide(w.layerFor(base)));
      });
    },
  );
});

const caller: Caller = {
  requestId: "req-1",
  principal: { _tag: "Anonymous" },
  signal: new AbortController().signal,
};

describe("commit at the doorway", () => {
  it("[commit.input] reads utf8 and base64 content, keeps a delete, and leaves parent absent when not given", () => {
    const decoded = commitInput({
      changeId,
      "keel-lease": "lse_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "idempotency-key": "key-commit-1",
      expectedHead: "a".repeat(40),
      message: "m",
      edits: [
        { path: "a.txt", content: "héllo" },
        { path: "b.bin", content: "AAEC/w==", encoding: "base64", executable: true },
        { path: "c.txt", delete: true },
      ],
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    const input = Result.getOrThrow(decoded);
    expect(input).not.toHaveProperty("parent");
    expect(input.edits).toEqual([
      { path: "a.txt", content: new TextEncoder().encode("héllo") },
      { path: "b.bin", content: new Uint8Array([0, 1, 2, 255]), executable: true },
      { path: "c.txt", delete: true },
    ]);
  });

  it("[commit.input-refused] refuses an edit with both or neither of content and delete, and base64 that is not", () => {
    const decoded = commitInput({
      changeId,
      "keel-lease": "lse_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
      "idempotency-key": "key-commit-1",
      expectedHead: "a".repeat(40),
      message: "m",
      edits: [
        { path: "a", content: "x", delete: true },
        { path: "b" },
        { path: "c", content: "not base64!", encoding: "base64" },
      ],
    });
    expect(Result.isFailure(decoded) ? decoded.failure.map((i) => i.path) : []).toEqual([
      ["edits", 0],
      ["edits", 1],
      ["edits", 2, "content"],
    ]);
  });

  it("[commit.error-map] answers each refusal with its status and code", () => {
    const repo = { namespace: "keel-ws-00", name: "prj-ws-x" };
    const cases = [
      [
        new WorkspaceHeadMoved({ expected: "a".repeat(40), head: "b".repeat(40) }),
        409,
        "workspace.head_moved",
      ],
      [new EditsRefused({ reason: "duplicate-path", path: "x" }), 400, "commit.bad_edits"],
      [new EditsRefused({ reason: "missing", path: "x" }), 409, "commit.edits_refused"],
      [new EditsRefused({ reason: "nothing-changed", path: "" }), 409, "commit.edits_refused"],
      [new ObjectNotFound({ repo, oid: "c".repeat(40) }), 404, "commit.parent_not_found"],
      [new PackTooLarge({ repo, bytes: 70, limit: 60 }), 409, "workspace.pack_too_large"],
      [
        new CommitParentRefused({ changeId, parent: "c".repeat(40), expectedHead: "a".repeat(40) }),
        400,
        "commit.parent_refused",
      ],
    ] as const;
    expect(
      cases.map(([error]) => {
        const answer = commitEditsError(caller, error);
        return [answer.status, "code" in answer.body ? answer.body.code : undefined];
      }),
    ).toEqual(cases.map(([, status, code]) => [status, code]));
  });
});
