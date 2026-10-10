import { PoolExhausted, WorkspaceNotFound } from "@keeltown/core/domain/coordination";
import { InstantSchema, WorkspaceId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

export const WorkspaceGrant = Schema.Struct({
  workspaceId: WorkspaceId,
  remote: Schema.String,
  token: Schema.String,
  expiresAt: InstantSchema,
});

export const WorkspacePoolCodecs = {
  grant: exitCodec(WorkspaceGrant, PoolExhausted),
  release: exitCodec(Schema.Void, WorkspaceNotFound),
};

/** The WorkspacePool DO (`pool:<project>`): pre-forked workspaces and sketches. */
export interface WorkspacePoolRpc {
  grant(holder: string): Promise<ExitJson>;
  release(workspaceId: typeof WorkspaceId.Encoded): Promise<ExitJson>;
}
