import { Context, type Effect } from "effect";
import type { PoolExhausted } from "../../domain/coordination/index.ts";
import type { ChangeId, CommitSha, Instant, ProjectId, SketchId, WorkspaceId } from "../../domain/kernel/index.ts";

/**
 * A workspace handed to its holder. `remote` and `token` go to the holder
 * only: the remote's host carries the account id, and the write token (≤ 2 h)
 * is minted per grant and never stored. `baseSha` is the workspace's head when
 * it was granted: the change's base, which Precheck diffs against.
 */
export interface WorkspaceGrant {
  readonly workspaceId: WorkspaceId;
  readonly remote: string;
  readonly token: string;
  readonly expiresAt: Instant;
  readonly baseSha: CommitSha;
}

/** Why a workspace is collected (its repo deleted). */
export type CollectionReason = "landed" | "withdrawn" | "expired";

/** Hands out pre-forked workspaces. A fork is ready when the pool's own `await fork()` resolves (spike S2); nothing polls, and no fork event exists to wait for. */
export class WorkspacePool extends Context.Service<WorkspacePool, {
  /**
   * Idempotent per holder: a retried grant for the same holder returns the
   * same workspace with a freshly minted token. No ready workspace → PoolExhausted.
   */
  readonly grant: (projectId: ProjectId, holder: ChangeId | SketchId) => Effect.Effect<WorkspaceGrant, PoolExhausted>;
  /** Collects the workspace: its repo is deleted. */
  readonly release: (workspaceId: WorkspaceId, reason?: CollectionReason) => Effect.Effect<void>;
}>()("keel/WorkspacePool") {}
