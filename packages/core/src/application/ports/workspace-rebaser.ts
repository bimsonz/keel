import { Context, type Effect } from "effect";
import type { PushRejected } from "../../domain/integration/index.ts";
import type { CommitSha, ProjectId } from "../../domain/kernel/index.ts";
import type { RepoNotFound, RepoRef } from "./code-host.ts";
import type { PackTooLarge, SyncOutcome } from "./trunk-writer.ts";

/**
 * Where a rebase puts trunk in a workspace: a branch the agent fetches and
 * merges (`git fetch origin keel/trunk && git merge FETCH_HEAD`). Keel's own
 * namespace, so a push to it is never recorded as the agent's.
 */
export const KEEL_TRUNK_REF = "refs/heads/keel/trunk";

/**
 * Where a proposal's commits are held in its workspace: copied there by Keel
 * from the fork, in Keel's own namespace, so the push is never recorded as
 * anyone's and no agent's branch is touched.
 */
export const KEEL_PROPOSAL_REF = "refs/heads/keel/proposal";

/**
 * Brings trunk into a change's workspace, so a change bounced on a textual
 * conflict can merge the trunk it must now build on, and a fork's commit into
 * a proposal's. It reads the source repo and writes only `KEEL_TRUNK_REF` or
 * `KEEL_PROPOSAL_REF` in the workspace, never an agent's branches.
 */
export class WorkspaceRebaser extends Context.Service<
  WorkspaceRebaser,
  {
    /**
     * Relays `projectId`'s trunk at `head` into the workspace's `KEEL_TRUNK_REF`, with the
     * ref's current value (zero when it has none) as the explicit old value
     * and `base` (the change's base, which the workspace holds) among the
     * haves, so only what lies past it is sent. A ref already at `head` is
     * `unchanged`. RepoNotFound: the workspace is gone. PushRejected `stale`:
     * the ref kept moving under each attempt; `busy`: the workspace stayed
     * busy. Nothing moved in either case.
     */
    readonly pushTrunk: (
      projectId: ProjectId,
      workspace: RepoRef,
      base: CommitSha,
      head: CommitSha,
    ) => Effect.Effect<SyncOutcome, RepoNotFound | PushRejected | PackTooLarge>;
    /**
     * Copies `commit` of `source` (a fork's trunk) into the workspace's
     * `KEEL_PROPOSAL_REF`. The pack of what `commit` reaches past `haves`
     * (commits the workspace holds, which the fork may hold too) is fetched
     * once, `admit` is run on its length before anything is asked of the
     * workspace, and that very pack is pushed with the ref's current value
     * (zero when it has none) as the explicit old value, read again if it
     * moved. A ref already at `commit` is `unchanged`, and sends nothing.
     * RepoNotFound: the workspace or the fork is gone. PushRejected `stale`:
     * the ref kept moving; `busy`: the workspace stayed busy. PackTooLarge,
     * naming the workspace, or a failing `admit`: nothing was pushed.
     */
    readonly pushProposal: <E>(
      source: RepoRef,
      workspace: RepoRef,
      commit: CommitSha,
      haves: readonly CommitSha[],
      admit: (packBytes: number) => Effect.Effect<void, E>,
    ) => Effect.Effect<SyncOutcome, RepoNotFound | PushRejected | PackTooLarge | E>;
  }
>()("keel/WorkspaceRebaser") {}
