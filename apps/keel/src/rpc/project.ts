import { IdempotencyConflict } from "@keeltown/core/domain/identity";
import { ProjectNotFound } from "@keeltown/core/domain/integration";
import { AgentId, Glob, InstantSchema, ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";
import { RepoRef } from "./workspace-pool.ts";

export const ProjectSettings = Schema.Struct({
  protectedPaths: Schema.Array(Glob),
  maxBatchSize: Schema.Int,
});

/**
 * Create the project this DO is named for. The isolate derives `projectId`
 * from the operator and the Idempotency-Key, so a retry reaches the same DO,
 * which replays by `idempotencyKey` and refuses another body (`fingerprint`)
 * with IdempotencyConflict. Trunk is forked from `source`, a repo in the core
 * namespace; staging is forked from trunk; the per-project mirror is created
 * empty in the workspace namespace and trunk's head is pushed into it; then the
 * pool is configured and trunk is initialised at that head.
 */
export const CreateProjectCommand = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  /** The repo in the core namespace that trunk is forked from. */
  source: Schema.NonEmptyString,
  by: AgentId,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

export const ProjectView = Schema.Struct({
  id: ProjectId,
  name: Schema.NonEmptyString,
  createdAt: InstantSchema,
});

/**
 * CodeHost's RepoNotFound, by shape: this folder cannot import the ports (rule
 * R15), so the DO answers the port's error as is and the caller rebuilds it.
 */
export const RepoNotFound = Schema.TaggedStruct("RepoNotFound", { repo: RepoRef });

export const ProjectCodecs = {
  settings: exitCodec(ProjectSettings, ProjectNotFound),
  putSettings: exitCodec(ProjectSettings, ProjectNotFound),
  createProject: exitCodec(ProjectView, Schema.Union([IdempotencyConflict, RepoNotFound])),
};

/** The Project DO (`project:<id>`): settings and the subject registry. */
export interface ProjectRpc extends EventReceiverRpc {
  settings(): Promise<ExitJson>;
  putSettings(
    projectId: typeof ProjectId.Encoded,
    settings: typeof ProjectSettings.Encoded,
  ): Promise<ExitJson>;
  createProject(command: typeof CreateProjectCommand.Encoded): Promise<ExitJson>;
}
