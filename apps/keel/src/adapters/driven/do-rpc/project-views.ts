import { ProjectViews } from "@keeltown/core/ports";
import { Layer } from "effect";
import {
  type ChangesRead,
  type ConflictRead,
  type ConflictsRead,
  ProjectorCodecs,
  type SnapshotRead,
} from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Projector DO methods the isolate calls for its read models, each answering an Exit envelope. */
export interface ProjectViewsStub {
  changes(request: typeof ChangesRead.Encoded): Promise<unknown>;
  snapshot(request: typeof SnapshotRead.Encoded): Promise<unknown>;
  conflicts(request: typeof ConflictsRead.Encoded): Promise<unknown>;
  conflict(request: typeof ConflictRead.Encoded): Promise<unknown>;
}

/**
 * `ProjectViews` over the one Projector DO (`projector`), which folds every
 * event it records into the read models in the same transaction, so a
 * snapshot's cursor is exactly the feed position its changes include.
 */
export function ProjectViewsRpc(projector: () => ProjectViewsStub): Layer.Layer<ProjectViews> {
  return Layer.succeed(
    ProjectViews,
    ProjectViews.of({
      changes: ({ project, state, cursor, limit }) =>
        callObject(ProjectorCodecs.changes, () =>
          projector().changes({
            project,
            ...(state === undefined ? {} : { state }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          }),
        ),
      snapshot: (project) =>
        callObject(ProjectorCodecs.snapshot, () => projector().snapshot({ project })),
      conflicts: ({ project, open, state, changeId, cursor, limit }) =>
        callObject(ProjectorCodecs.conflicts, () =>
          projector().conflicts({
            project,
            ...(open === undefined ? {} : { open }),
            ...(state === undefined ? {} : { state }),
            ...(changeId === undefined ? {} : { changeId }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          }),
        ),
      conflict: (project, conflictId) =>
        callObject(ProjectorCodecs.conflict, () => projector().conflict({ project, conflictId })),
    }),
  );
}
