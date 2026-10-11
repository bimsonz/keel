import { Context, type Effect } from "effect";
import type { PushRejected } from "../../domain/integration/index.ts";
import type { CommitSha } from "../../domain/kernel/index.ts";
import type { RepoNotFound, RepoRef } from "./code-host.ts";
import type { PackTooLarge, SyncOutcome } from "./trunk-writer.ts";

/**
 * Where a rebase puts trunk in a workspace: a branch the agent fetches and
 * merges (`git fetch origin keel/trunk && git merge FETCH_HEAD`). Keel's own
 * namespace, so a push to it is never recorded as the agent's.
 */
export const KEEL_TRUNK_REF = "refs/heads/keel/trunk";

/**
 * Brings trunk into a change's workspace, so a change bounced on a textual
 * conflict can merge the trunk it must now build on. It reads trunk and
 * writes only `KEEL_TRUNK_REF` in the workspace, never the agent's branches.
 */
export class WorkspaceRebaser extends Context.Service<
  WorkspaceRebaser,
  {
    /**
     * Relays trunk's `head` into the workspace's `KEEL_TRUNK_REF`, with the
     * ref's current value (zero when it has none) as the explicit old value
     * and `base` (the change's base, which the workspace holds) among the
     * haves, so only what lies past it is sent. A ref already at `head` is
     * `unchanged`. RepoNotFound: the workspace is gone. PushRejected `stale`:
     * the ref kept moving under each attempt; `busy`: the workspace stayed
     * busy. Nothing moved in either case.
     */
    readonly pushTrunk: (
      workspace: RepoRef,
      base: CommitSha,
      head: CommitSha,
    ) => Effect.Effect<SyncOutcome, RepoNotFound | PushRejected | PackTooLarge>;
  }
>()("keel/WorkspaceRebaser") {}
