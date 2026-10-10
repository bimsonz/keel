import { Context, type Effect } from "effect";
import type { PoolExhausted } from "../../domain/coordination/index.ts";
import type { ChangeId, Instant, ProjectId, SketchId, WorkspaceId } from "../../domain/kernel/index.ts";

export interface WorkspaceGrant {
  readonly workspaceId: WorkspaceId;
  readonly remote: string;
  readonly token: string;
  readonly expiresAt: Instant;
}

/** Hands out pre-forked workspaces. Readiness comes from the fork event, never from polling. */
export class WorkspacePool extends Context.Service<WorkspacePool, {
  readonly grant: (projectId: ProjectId, holder: ChangeId | SketchId) => Effect.Effect<WorkspaceGrant, PoolExhausted>;
  readonly release: (workspaceId: WorkspaceId) => Effect.Effect<void>;
}>()("keel/WorkspacePool") {}
