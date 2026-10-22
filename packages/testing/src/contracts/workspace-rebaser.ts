import { describe, expect, it } from "@effect/vitest";
import type { ProjectId } from "@keeltown/core/kernel";
import {
  CodeHost,
  KEEL_PROPOSAL_REF,
  KEEL_TRUNK_REF,
  type RepoRef,
  WorkspaceRebaser,
} from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";
import { CodeHostFixture } from "../code-host-fixture.ts";

const MAIN = "refs/heads/main";

/** What an admission refused fails with, in the suite: the push's own failure. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { bytes: Schema.Number }) {}
const refuse = (bytes: number) => Effect.fail(new Refused({ bytes }));

/**
 * A rebaser that finds `projectId`'s trunk at `trunk`, beside the code host it
 * writes through and a fixture to seed it. `trunk` is a name no test has used:
 * the suite creates it.
 */
export interface WorkspaceRebaserHarness {
  readonly layer: Layer.Layer<WorkspaceRebaser | CodeHost | CodeHostFixture>;
  readonly projectId: ProjectId;
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
        const { layer, projectId, trunk } = make();
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

          expect(yield* rebaser.pushTrunk(projectId, workspace, base, landed)).toBe("advanced");
          expect(yield* host.head(workspace, KEEL_TRUNK_REF)).toBe(landed);
          expect(yield* host.readTree(workspace, landed)).toEqual(
            yield* host.readTree(trunk, landed),
          );
          expect(yield* host.head(workspace, MAIN)).toBe(work);
          expect(yield* host.head(trunk, MAIN)).toBe(landed);
          expect(yield* rebaser.pushTrunk(projectId, workspace, base, landed)).toBe("unchanged");

          const later = yield* fixture.commit(trunk, MAIN, { "README.md": "later\n" });
          expect(yield* rebaser.pushTrunk(projectId, workspace, base, later)).toBe("advanced");
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

    it.live(
      "[rebaser.contract.proposal] a fork's commit lands on the workspace's keel/proposal and nowhere else, admitted on a pack of some bytes first; again is unchanged and admits nothing; a refused admission moves nothing",
      () => {
        const { layer, trunk } = make();
        return Effect.gen(function* () {
          const host = yield* CodeHost;
          const fixture = yield* CodeHostFixture;
          const rebaser = yield* WorkspaceRebaser;
          yield* host.create(trunk);
          const base = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
          // A fork of trunk with work of its own, and a workspace of trunk granted later.
          const fork = yield* host.fork(trunk, fixture.scratch());
          const proposed = yield* fixture.commit(fork, MAIN, { "README.md": "base\n", p: "1\n" });
          const workspace = yield* host.fork(trunk, fixture.scratch());
          const admitted: number[] = [];
          const admit = (bytes: number) => Effect.sync(() => void admitted.push(bytes));

          expect(yield* rebaser.pushProposal(fork, workspace, proposed, [base], admit)).toBe(
            "advanced",
          );
          expect(admitted).toHaveLength(1);
          expect(admitted[0]).toBeGreaterThan(0);
          expect(yield* host.head(workspace, KEEL_PROPOSAL_REF)).toBe(proposed);
          expect(yield* host.readTree(workspace, proposed)).toEqual(
            yield* host.readTree(fork, proposed),
          );
          expect(yield* host.head(workspace, MAIN)).toBe(base);
          expect(yield* host.isAncestor(workspace, base, proposed, [])).toBe(true);
          expect(yield* rebaser.pushProposal(fork, workspace, proposed, [base], admit)).toBe(
            "unchanged",
          );
          expect(admitted).toHaveLength(1);

          const later = yield* fixture.commit(fork, MAIN, { "README.md": "base\n", p: "2\n" });
          expect(
            yield* Effect.flip(rebaser.pushProposal(fork, workspace, later, [base], refuse)),
          ).toMatchObject({ _tag: "Refused" });
          expect(yield* host.head(workspace, KEEL_PROPOSAL_REF)).toBe(proposed);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("[rebaser.contract.missing] a workspace that is gone fails RepoNotFound", () => {
      const { layer, projectId, trunk } = make();
      return Effect.gen(function* () {
        const host = yield* CodeHost;
        const fixture = yield* CodeHostFixture;
        const rebaser = yield* WorkspaceRebaser;
        yield* host.create(trunk);
        const head = yield* fixture.commit(trunk, MAIN, { "README.md": "base\n" });
        const gone = fixture.scratch();
        expect(yield* Effect.flip(rebaser.pushTrunk(projectId, gone, head, head))).toMatchObject({
          _tag: "RepoNotFound",
          repo: { namespace: gone.namespace, name: gone.name },
        });
      }).pipe(Effect.provide(layer));
    });
  });
}
