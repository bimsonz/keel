import { Schema } from "effect";
import { ChangeId, CommitSha, InstantSchema, WorkspaceId } from "../kernel/index.ts";

/**
 * A workspace's lifecycle as its events tell it. The pool's own slots also
 * pass through `forking` (before `WorkspaceForked`, so not yet a workspace)
 * and `collecting` (the repo's deletion in progress, still Collected here).
 */
export const WorkspaceState = Schema.Literals(["ready", "granted", "collected"]);
export type WorkspaceState = typeof WorkspaceState.Type;

/** The throwaway Artifacts repo a Change is worked in. */
export const Workspace = Schema.Struct({
  id: WorkspaceId,
  repo: Schema.String,
  sourceRepo: Schema.String,
  state: WorkspaceState,
  /** The change that holds it once granted. */
  holder: Schema.optional(ChangeId),
  /** Its head when granted: the holder's base. */
  baseSha: Schema.optional(CommitSha),
  expiresAt: Schema.optional(InstantSchema),
});
export type Workspace = typeof Workspace.Type;
