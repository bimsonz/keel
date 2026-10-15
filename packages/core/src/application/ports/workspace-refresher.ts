import { Context, type Effect } from "effect";
import type { PushRejected } from "../../domain/integration/index.ts";
import type { CommitSha, ProjectId } from "../../domain/kernel/index.ts";
import type { RepoNotFound, RepoRef } from "./code-host.ts";
import type { PackTooLarge, SyncOutcome } from "./trunk-writer.ts";

/**
 * Brings a workspace nobody holds yet up to trunk, so the change that is
 * granted it next starts from trunk's head. It reads trunk and writes the
 * workspace's main. The pool calls it only for a workspace it has not
 * granted: a held workspace's main is its agent's, and trunk reaches it
 * through `WorkspaceRebaser`'s `keel/trunk` instead.
 */
export class WorkspaceRefresher extends Context.Service<
  WorkspaceRefresher,
  {
    /**
     * Relays `projectId`'s trunk at `to` into the workspace's
     * `refs/heads/main`, with `from` (where the pool last knew main) as the
     * explicit old value and the only have: just what lies past it is sent,
     * and a main that is anywhere else refuses the push. `from` equal to `to`
     * is `unchanged` and sends nothing. RepoNotFound: the workspace is gone.
     * PushRejected `stale`: main was not at `from`, or `to` is behind `from`
     * (a workspace is only ever moved forward); `busy`: the workspace stayed
     * busy. Nothing moved in any of these. It never reads main back: the
     * caller does, to learn where a refused or lost push left it. `from`
     * null is an empty workspace with no main yet: trunk's whole history at
     * `to` is sent, and a main that exists refuses it.
     */
    readonly advance: (
      projectId: ProjectId,
      workspace: RepoRef,
      from: CommitSha | null,
      to: CommitSha,
    ) => Effect.Effect<SyncOutcome, RepoNotFound | PushRejected | PackTooLarge>;
  }
>()("keel/WorkspaceRefresher") {}
