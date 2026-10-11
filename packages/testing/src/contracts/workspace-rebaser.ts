import { describe, expect, it } from "@effect/vitest";
import { CodeHost, KEEL_TRUNK_REF, type RepoRef, WorkspaceRebaser } from "@keeltown/core/ports";
import { Effect, type Layer } from "effect";
import { CodeHostFixture } from "../code-host-fixture.ts";

const MAIN = "refs/heads/main";

/**
 * A rebaser reading `trunk`, beside the code host it writes through and a
 * fixture to seed it. `trunk` is a name no test has used: the suite creates it.
 */
export interface WorkspaceRebaserHarness {
  readonly layer: Layer.Layer<WorkspaceRebaser | CodeHost | CodeHostFixture>;
  readonly trunk: RepoRef;
}

export function describeWorkspaceRebaserContract(
  adapter: string,
  make: () => WorkspaceRebaserHarness,
) {
  describe(`WorkspaceRebaser contract: ${adapter}`, () => {
    it.live(
      "[rebaser.contract.push] trunk's head lands on the workspace's keel/trunk and nowhere else; again is unchanged; a later head moves it on",
      () => {
        const { layer, trunk } = make();
        return Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const rebaser = yield* WorkspaceRebaser;
          yield* host.create(trunk);
          const base = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
          // A workspace forked at base, where the agent has committed since.
          const workspace = yield* host.fork(trunk, fixture.scratch());
          const work = yield* fixture.commit(workspace, MAIN, { "README.md": "base\n", w: "1\n" });
          const landed = yield* fixture.commit(trunk, MAIN, { "README.md": "landed\n" });

          expect(yield* rebaser.pushTrunk(workspace, base, landed)).toBe("advanced");
          expect(yield* host.head(workspace, KEEL_TRUNK_REF)).toBe(landed);
          expect(yield* host.readTree(workspace, landed)).toEqual(
            yield* host.readTree(trunk, landed),
          );
          expect(yield* host.head(workspace, MAIN)).toBe(work);
          expect(yield* host.head(trunk, MAIN)).toBe(landed);
          expect(yield* rebaser.pushTrunk(workspace, base, landed)).toBe("unchanged");

          const later = yield* fixture.commit(trunk, MAIN, { "README.md": "later\n" });
          expect(yield* rebaser.pushTrunk(workspace, base, later)).toBe("advanced");
          expect(yield* host.head(workspace, KEEL_TRUNK_REF)).toBe(later);
          expect(yield* host.head(workspace, MAIN)).toBe(work);

          // The agent merges what it was given; the merge descends from trunk's head.
          const merged = yield* fixture.commit(
            workspace,
            MAIN,
            { "README.md": "later\n", w: "1\n" },
            [later],
          );
          expect(yield* host.isAncestor(workspace, later, merged, [base])).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("[rebaser.contract.missing] a workspace that is gone fails RepoNotFound", () => {
      const { layer, trunk } = make();
      return Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const rebaser = yield* WorkspaceRebaser;
        yield* host.create(trunk);
        const head = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
        const gone = fixture.scratch();
        expect(yield* Effect.flip(rebaser.pushTrunk(gone, head, head))).toMatchObject({
          _tag: "RepoNotFound",
          repo: { namespace: gone.namespace, name: gone.name },
        });
      }).pipe(Effect.provide(layer));
    });
  });
}
