import { describe, expect, it } from "@effect/vitest";
import {
  type ChangeId,
  CommitSha,
  makeId,
  type ProjectId,
  type WorkspaceId,
} from "@keeltown/core/kernel";
import { WorkspacePool } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

/**
 * A pool for `projectId` holding `capacity` ready workspaces and forking no
 * more, so exhaustion is deterministic. Each case asks for a fresh project.
 */
export type StockedPool = (projectId: ProjectId, capacity: number) => Layer.Layer<WorkspacePool>;

/** A grant's token lives at most two hours. */
const TWO_HOURS_MS = 7_200_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 26 random Crockford characters: a well-formed ULID, unique enough to give each case its own pool. */
const randomUlid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32]).join("");
const freshProject = (): ProjectId => makeId("prj", randomUlid());
const holder = (): ChangeId => makeId("chg", randomUlid());
const isCommitSha = Schema.is(CommitSha);

/** Runs `body` against a fresh project's pool of `capacity`. */
function withPool<A, E>(
  make: StockedPool,
  capacity: number,
  body: (projectId: ProjectId) => Effect.Effect<A, E, WorkspacePool>,
) {
  const projectId = freshProject();
  return body(projectId).pipe(Effect.provide(make(projectId, capacity)));
}

export function describeWorkspacePoolContract(adapter: string, make: StockedPool) {
  describe(`WorkspacePool contract: ${adapter}`, () => {
    it.live("[pool.contract.grant] a grant hands out a ready workspace and its write token", () =>
      withPool(make, 1, (projectId) =>
        Effect.gen(function* () {
          const pool = yield* WorkspacePool;
          const before = Date.now();
          const grant = yield* pool.grant(projectId, holder());
          expect(grant.token).not.toBe("");
          expect(grant.remote).not.toBe("");
          expect(grant.repo.name).not.toBe("");
          expect(isCommitSha(grant.baseSha)).toBe(true);
          expect(grant.expiresAt).toBeGreaterThan(before);
          expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + TWO_HOURS_MS);
        }),
      ),
    );

    it.live(
      "[pool.contract.retry] a retried grant returns the holder's workspace with a fresh token",
      () =>
        withPool(make, 2, (projectId) =>
          Effect.gen(function* () {
            const pool = yield* WorkspacePool;
            const who = holder();
            const first = yield* pool.grant(projectId, who);
            const again = yield* pool.grant(projectId, who);
            expect(again.workspaceId).toBe(first.workspaceId);
            expect(again.repo).toEqual(first.repo);
            expect(again.baseSha).toBe(first.baseSha);
            expect(again.token).not.toBe(first.token);
          }),
        ),
    );

    it.live(
      "[pool.contract.distinct] concurrent grants to different holders never share a workspace",
      () =>
        withPool(make, 5, (projectId) =>
          Effect.gen(function* () {
            const pool = yield* WorkspacePool;
            const grants = yield* Effect.forEach(
              Array.from({ length: 5 }, holder),
              (who) => pool.grant(projectId, who),
              { concurrency: "unbounded" },
            );
            expect(new Set(grants.map((g) => g.workspaceId)).size).toBe(5);
            expect(new Set(grants.map((g) => g.repo.name)).size).toBe(5);
          }),
        ),
    );

    it.live(
      "[pool.contract.exhausted] past its capacity the pool refuses with PoolExhausted, yet a holder keeps its own",
      () =>
        withPool(make, 1, (projectId) =>
          Effect.gen(function* () {
            const pool = yield* WorkspacePool;
            const first = holder();
            const granted = yield* pool.grant(projectId, first);
            const refused = yield* Effect.flip(pool.grant(projectId, holder()));
            expect(refused._tag).toBe("PoolExhausted");
            expect(refused.retryAfterMs).toBeGreaterThan(0);
            expect((yield* pool.grant(projectId, first)).workspaceId).toBe(granted.workspaceId);
          }),
        ),
    );

    it.live(
      "[pool.contract.release] a released workspace is never granted again; releasing twice is a no-op",
      () =>
        withPool(make, 2, (projectId) =>
          Effect.gen(function* () {
            const pool = yield* WorkspacePool;
            const who = holder();
            const first = yield* pool.grant(projectId, who);
            yield* pool.release(projectId, first.workspaceId, "withdrawn");
            yield* pool.release(projectId, first.workspaceId);
            const next = yield* pool.grant(projectId, who);
            expect(next.workspaceId).not.toBe(first.workspaceId);
            expect(next.repo.name).not.toBe(first.repo.name);
          }),
        ),
    );

    it.live(
      "[pool.contract.observe-push] a push to a granted workspace is recorded, a retry answers the same, and a push to a released or unknown one is ignored",
      () =>
        withPool(make, 1, (projectId) =>
          Effect.gen(function* () {
            const pool = yield* WorkspacePool;
            const grant = yield* pool.grant(projectId, holder());
            const push = (workspaceId: WorkspaceId) => ({
              workspaceId,
              ref: "refs/heads/main",
              sha: grant.baseSha,
            });
            const pushId = randomUlid();
            expect(yield* pool.observePush(projectId, pushId, push(grant.workspaceId))).toBe(
              "recorded",
            );
            expect(yield* pool.observePush(projectId, pushId, push(grant.workspaceId))).toBe(
              "recorded",
            );
            const unknown = makeId("wsp", randomUlid());
            expect(yield* pool.observePush(projectId, randomUlid(), push(unknown))).toBe("ignored");
            yield* pool.release(projectId, grant.workspaceId, "withdrawn");
            expect(yield* pool.observePush(projectId, randomUlid(), push(grant.workspaceId))).toBe(
              "ignored",
            );
          }),
        ),
    );
  });
}
