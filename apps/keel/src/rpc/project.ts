import { ProjectNotFound } from "@keeltown/core/domain/integration";
import { Glob, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

export const ProjectSettings = Schema.Struct({
  protectedPaths: Schema.Array(Glob),
  maxBatchSize: Schema.Int,
});

export const ProjectCodecs = {
  settings: exitCodec(ProjectSettings, ProjectNotFound),
  putSettings: exitCodec(ProjectSettings, ProjectNotFound),
};

/** The Project DO (`project:<id>`): settings and the subject registry. */
export interface ProjectRpc extends EventReceiverRpc {
  settings(): Promise<ExitJson>;
  putSettings(
    projectId: typeof ProjectId.Encoded,
    settings: typeof ProjectSettings.Encoded,
  ): Promise<ExitJson>;
}
