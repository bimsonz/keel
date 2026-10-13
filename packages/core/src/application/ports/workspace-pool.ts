import { Context, type Effect } from "effect";
import type { PoolExhausted } from "../../domain/coordination/index.ts";
import type {
  ChangeId,
  CommitSha,
  Instant,
  ProjectId,
  SketchId,
  WorkspaceId,
} from "../../domain/kernel/index.ts";
import type { RepoRef } from "./code-host.ts";

/**
 * A workspace handed to its holder. `remote` and `token` go to the holder
 * only: the remote's host carries the account id, and the write token (≤ 2 h)
 * is minted per grant and never stored. `baseSha` is the workspace's head when
 * it was granted, which is trunk's head as its Trunk recorded it while the
 * claim was served: the change's base, which Precheck diffs against. `repo`
 * names the workspace's repo on the code host, for `hasCommit` and
 * `diffTrees`; it is never logged next to the remote.
 */
export interface WorkspaceGrant {
  readonly workspaceId: WorkspaceId;
  readonly remote: string;
  readonly token: string;
  readonly expiresAt: Instant;
  readonly baseSha: CommitSha;
  readonly repo: RepoRef;
}

/** What a project's pool forks from, and how many ready workspaces it keeps. */
export interface PoolConfig {
  readonly source: RepoRef;
  readonly target: number;
}

/** A push to a workspace's branch, as Artifacts reported it. */
export interface ObservedPush {
  readonly workspaceId: WorkspaceId;
  readonly ref: string;
  readonly sha: CommitSha;
}

/** What became of an observed push: WorkspacePushed was committed for it, or it was not an agent's. */
export type PushObservation = "recorded" | "ignored";

/** Why a workspace is collected (its repo deleted). */
export type CollectionReason = "landed" | "withdrawn" | "expired";

/** Hands out pre-forked workspaces. A fork is ready when the pool's own `await fork()` resolves (spike S2); nothing polls, and no fork event exists to wait for. */
export class WorkspacePool extends Context.Service<
  WorkspacePool,
  {
    /**
     * A workspace at trunk's head: every landing recorded before the claim
     * arrived is in it. Idempotent per holder: a retried grant for the same
     * holder returns the same workspace, where it stands, with a freshly
     * minted token. No ready workspace, or none that could be brought to
     * trunk's head → PoolExhausted; never a workspace behind trunk.
     */
    readonly grant: (
      projectId: ProjectId,
      holder: ChangeId | SketchId,
    ) => Effect.Effect<WorkspaceGrant, PoolExhausted>;
    /**
     * Collects the workspace: its repo is deleted. Releasing it again is a
     * no-op. A change's end collects its workspace by event; this is for a
     * declare refused after its grant.
     */
    readonly release: (
      projectId: ProjectId,
      workspaceId: WorkspaceId,
      reason?: CollectionReason,
    ) => Effect.Effect<void>;
    /**
     * The change or sketch the workspace is granted to; undefined for one that
     * is ready, collected, or not this project's pool's. Reads, commits nothing.
     */
    readonly holder: (
      projectId: ProjectId,
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ChangeId | SketchId | undefined>;
    /**
     * Points the project's pool at its source (the project's mirror) and the
     * number of ready workspaces to keep forked. The pool starts forking.
     */
    readonly configure: (projectId: ProjectId, config: PoolConfig) => Effect.Effect<void>;
    /**
     * Commits WorkspacePushed for a push that moved a workspace granted to
     * its holder past its base, once per `pushId` (a retried observation
     * answers the same). A push to any other repo, or one that leaves the
     * workspace's branch on the base it was granted at, is Keel's own write
     * or nobody's and is ignored, so no agent is woken by Keel's writes (ADR
     * 0009: no self-loops).
     */
    readonly observePush: (
      projectId: ProjectId,
      pushId: string,
      push: ObservedPush,
    ) => Effect.Effect<PushObservation>;
    /**
     * Destroys the project's pool, for good (its project was deleted): no
     * workspace is granted from here on, not even to a holder again, and
     * every workspace repo the pool holds is deleted, retried until none is
     * left. Idempotent.
     */
    readonly destroy: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("keel/WorkspacePool") {}
