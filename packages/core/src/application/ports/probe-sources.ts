import { Context, type Effect } from "effect";
import type { CommitSha, ContentHash, NamespaceId } from "../../domain/kernel/index.ts";
import type { NoNoop, NoopRecipe } from "../verification/index.ts";
import type { ObjectNotFound, RepoNotFound, RepoRef } from "./code-host.ts";

/** One file of a tree, as text. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * What a probe's draft is told about the code: the
 * project's `src/` and each change's hunks. Only text is read: a file that is
 * not UTF-8 is left out of both.
 */
export class ProbeSources extends Context.Service<
  ProbeSources,
  {
    /** Every file under `src/` at `commit`, whole, in path order. Never pruned: a pruned set broke every draft (S26). */
    readonly source: (
      repo: RepoRef,
      commit: CommitSha,
    ) => Effect.Effect<readonly SourceFile[], RepoNotFound | ObjectNotFound>;
    /**
     * The change from `base` to `head` as `git diff` writes it: per changed
     * file, `diff --git a/<path> b/<path>`, `--- a/<path>` (or `/dev/null`),
     * `+++ b/<path>` (or `/dev/null`) and its hunks.
     */
    readonly hunks: (
      repo: RepoRef,
      base: CommitSha,
      head: CommitSha,
    ) => Effect.Effect<string, RepoNotFound | ObjectNotFound>;
  }
>()("keel/ProbeSources") {}

/**
 * Builds A-noop's world: the premise-holder's world
 * bundle, as its world was built, with the recipe applied to the one file it
 * names, bundled again and stored where the VerifierDO reads the namespace's
 * world bundles.
 * It reads A's bundle, never A's workspace, which landing collects while a
 * draft may still be repairing. A recipe that cannot apply is NoNoop, for the
 * draft to repair; a world bundle that is not in the store is a defect, since
 * it was built for this draft.
 */
export class NoopWorlds extends Context.Service<
  NoopWorlds,
  {
    readonly build: (
      namespace: NamespaceId,
      world: ContentHash,
      recipe: NoopRecipe,
    ) => Effect.Effect<ContentHash, NoNoop>;
  }
>()("keel/NoopWorlds") {}
