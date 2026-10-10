import { PoolExhausted, WorkspaceNotFound } from "@keeltown/core/domain/coordination";
import { CommitSha, InstantSchema, WorkspaceId } from "@keeltown/core/kernel";
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

/** What the pool forks from, and how many ready workspaces it keeps. */
export const PoolConfig = Schema.Struct({
  source: RepoRef,
  target: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Workspaces by state. `forking` are not yet grantable; `collecting` are released and awaiting their repo's deletion. */
export const PoolStatus = Schema.Struct({
  source: Schema.NullOr(RepoRef),
  target: Schema.Int,
  ready: Schema.Int,
  forking: Schema.Int,
  granted: Schema.Int,
  collecting: Schema.Int,
});

export const WorkspacePoolCodecs = {
  grant: exitCodec(WorkspaceGrant, PoolExhausted),
  release: exitCodec(Schema.Void, WorkspaceNotFound),
  configure: exitCodec(PoolStatus, Schema.Never),
  status: exitCodec(PoolStatus, Schema.Never),
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
  configure(config: typeof PoolConfig.Encoded): Promise<ExitJson>;
  status(): Promise<ExitJson>;
}
