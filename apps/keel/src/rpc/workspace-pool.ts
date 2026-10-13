import { PoolExhausted, WorkspaceNotFound } from "@keeltown/core/domain/coordination";
import { ChangeId, CommitSha, InstantSchema, SketchId, WorkspaceId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

/** A repository on the code host: an Artifacts namespace and a repo name. */
export const RepoRef = Schema.Struct({ namespace: Schema.String, name: Schema.String });

export const WorkspaceGrant = Schema.Struct({
  workspaceId: WorkspaceId,
  remote: Schema.String,
  token: Schema.String,
  expiresAt: InstantSchema,
  baseSha: CommitSha,
  repo: RepoRef,
});

export const CollectionReason = Schema.Literals(["landed", "withdrawn", "expired"]);

/** A push to a workspace's branch, as Artifacts reported it. */
export const ObservedPush = Schema.Struct({
  workspaceId: WorkspaceId,
  ref: Schema.String,
  sha: CommitSha,
});

/** WorkspacePushed was committed for the push, or it was not an agent's (no self-loops). */
export const PushObservation = Schema.Literals(["recorded", "ignored"]);

/** What the pool forks from, and how many ready workspaces it keeps. */
export const PoolConfig = Schema.Struct({
  source: RepoRef,
  target: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Workspaces by state. `forking` are not yet grantable, and nor are `refreshing` ones, ready workspaces that trunk is being relayed into; `collecting` are released and awaiting their repo's deletion. A `destroyed` pool with none collecting has no repo left. */
export const PoolStatus = Schema.Struct({
  source: Schema.NullOr(RepoRef),
  target: Schema.Int,
  ready: Schema.Int,
  forking: Schema.Int,
  refreshing: Schema.Int,
  granted: Schema.Int,
  collecting: Schema.Int,
  destroyed: Schema.Boolean,
});

export const WorkspacePoolCodecs = {
  grant: exitCodec(WorkspaceGrant, PoolExhausted),
  release: exitCodec(Schema.Void, WorkspaceNotFound),
  // Null for a workspace with no holder: JSON carries no undefined.
  holder: exitCodec(Schema.NullOr(Schema.Union([ChangeId, SketchId])), Schema.Never),
  configure: exitCodec(PoolStatus, Schema.Never),
  status: exitCodec(PoolStatus, Schema.Never),
  observePush: exitCodec(PushObservation, Schema.Never),
  destroy: exitCodec(PoolStatus, Schema.Never),
};

/** The WorkspacePool DO (`pool:<project>`): pre-forked workspaces and sketches. */
export interface WorkspacePoolRpc {
  /** Idempotent per holder: a retry returns the same workspace with a fresh token. */
  grant(holder: string): Promise<ExitJson>;
  /** Collects the workspace; `reason` defaults to `withdrawn` for callers that predate it. */
  release(
    workspaceId: typeof WorkspaceId.Encoded,
    reason?: typeof CollectionReason.Encoded,
  ): Promise<ExitJson>;
  /** The change or sketch the workspace is granted to, or null while it is not granted. */
  holder(workspaceId: typeof WorkspaceId.Encoded): Promise<ExitJson>;
  configure(config: typeof PoolConfig.Encoded): Promise<ExitJson>;
  status(): Promise<ExitJson>;
  /** WorkspacePushed for a push to a granted workspace, once per `pushId`; any other push is ignored. */
  observePush(pushId: string, push: typeof ObservedPush.Encoded): Promise<ExitJson>;
  /**
   * Destroys the pool for good, when its project is deleted: it grants and
   * forks nothing from here on, and deletes every workspace repo it holds on
   * its collection deadline, retried until none is left. Idempotent; answers
   * the pool's status, whose `collecting` counts the repos still to delete.
   * A grant then answers PoolExhausted: the caller commits ProjectDeleted
   * before it destroys, so the retry meets the gate's 404 for the project.
   */
  destroy(): Promise<ExitJson>;
}
