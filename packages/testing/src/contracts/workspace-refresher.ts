import { describe, expect, it } from "@effect/vitest";
import type { ProjectId } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef, WorkspaceRefresher } from "@keeltown/core/ports";
import { Effect, type Layer } from "effect";
import { CodeHostFixture } from "../code-host-fixture.ts";

const MAIN = "refs/heads/main";

/**
 * A refresher that finds `projectId`'s trunk at `trunk`, beside the code host
 * it writes through and a fixture to seed it. `trunk` is a name no test has
 * used: the suite creates it.
 */
export interface WorkspaceRefresherHarness {
  readonly layer: Layer.Layer<WorkspaceRefresher | CodeHost | CodeHostFixture>;
  readonly projectId: ProjectId;
  readonly trunk: RepoRef;
}

export function describeWorkspaceRefresherContract(
  adapter: string,
  make: () => WorkspaceRefresherHarness,
) {
  describe(`WorkspaceRefresher contract: ${adapter}`, () => {
    it.live(
      "[refresher.contract.advance] trunk's head lands on a workspace's main with trunk's tree; the same commit again is unchanged; two landings behind arrive in one relay",
      () => {
        const { layer, projectId, trunk } = make();
        return Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const refresher = yield* WorkspaceRefresher;
          yield* host.create(trunk);
          const base = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
          const workspace = yield* host.fork(trunk, fixture.scratch());
          const landed = yield* fixture.commit(trunk, MAIN, { "README.md": "landed\n" });

          expect(yield* refresher.advance(projectId, workspace, base, landed)).toBe("advanced");
          expect(yield* host.head(workspace, MAIN)).toBe(landed);
          expect(yield* host.readTree(workspace, landed)).toEqual(
            yield* host.readTree(trunk, landed),
          );
          expect(yield* host.head(trunk, MAIN)).toBe(landed);
          expect(yield* refresher.advance(projectId, workspace, landed, landed)).toBe("unchanged");

          const second = yield* fixture.commit(trunk, MAIN, { "README.md": "second\n" });
          const third = yield* fixture.commit(trunk, MAIN, { "README.md": "third\n", a: "1\n" });
          expect(yield* refresher.advance(projectId, workspace, landed, third)).toBe("advanced");
          expect(yield* host.head(workspace, MAIN)).toBe(third);
          // The landing in between came with it: main's history is trunk's.
          expect(yield* host.isAncestor(workspace, second, third, [])).toBe(true);
          expect(yield* host.isAncestor(workspace, base, third, [])).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "[refresher.contract.stale] a workspace whose main is not where the caller says refuses with PushRejected stale, and its main stays where it was",
      () => {
        const { layer, projectId, trunk } = make();
        return Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const refresher = yield* WorkspaceRefresher;
          yield* host.create(trunk);
          const base = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
          const workspace = yield* host.fork(trunk, fixture.scratch());
          // Something wrote the workspace's main since the pool last knew it.
          const moved = yield* fixture.commit(workspace, MAIN, { "README.md": "base\n", w: "1\n" });
          const landed = yield* fixture.commit(trunk, MAIN, { "README.md": "landed\n" });

          expect(
            yield* Effect.flip(refresher.advance(projectId, workspace, base, landed)),
          ).toMatchObject({ _tag: "PushRejected", reason: "stale" });
          expect(yield* host.head(workspace, MAIN)).toBe(moved);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "[refresher.contract.not-forward] a commit behind a workspace's main is refused with PushRejected stale, and its main stays where it was: a workspace is never taken back",
      () => {
        const { layer, projectId, trunk } = make();
        return Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const refresher = yield* WorkspaceRefresher;
          yield* host.create(trunk);
          const base = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
          const landed = yield* fixture.commit(trunk, MAIN, { "README.md": "landed\n" });
          // Forked with the landing in it: trunk's earlier head is behind its main.
          const workspace = yield* host.fork(trunk, fixture.scratch());
          expect(yield* host.head(workspace, MAIN)).toBe(landed);

          expect(
            yield* Effect.flip(refresher.advance(projectId, workspace, landed, base)),
          ).toMatchObject({ _tag: "PushRejected", reason: "stale" });
          expect(yield* host.head(workspace, MAIN)).toBe(landed);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("[refresher.contract.missing] a workspace that is gone fails RepoNotFound", () => {
      const { layer, projectId, trunk } = make();
      return Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const refresher = yield* WorkspaceRefresher;
        yield* host.create(trunk);
        const base = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
        const landed = yield* fixture.commit(trunk, MAIN, { "README.md": "landed\n" });
        const gone = fixture.scratch();
        expect(yield* Effect.flip(refresher.advance(projectId, gone, base, landed))).toMatchObject({
          _tag: "RepoNotFound",
          repo: { namespace: gone.namespace, name: gone.name },
        });
      }).pipe(Effect.provide(layer));
    });
  });
}
