import { Context, type Effect } from "effect";
import type { CommitSha } from "../../domain/kernel/index.ts";
import type { ObjectNotFound, RepoNotFound, RepoRef } from "./code-host.ts";

/**
 * What a commit holds that decides its checks: the paths at its tree's root
 * (for pack detection), and `.keel/flow.json` and the root package.json as
 * text, each absent when the commit has none.
 */
export interface FlowSources {
  readonly rootPaths: readonly string[];
  readonly flowJson?: string;
  readonly packageJson?: string;
}

/** Reads a change's flow sources from its **base** commit, so a change cannot edit its own checks. */
export class FlowSpecSource extends Context.Service<
  FlowSpecSource,
  {
    readonly read: (
      repo: RepoRef,
      base: CommitSha,
    ) => Effect.Effect<FlowSources, RepoNotFound | ObjectNotFound>;
  }
>()("keel/FlowSpecSource") {}
