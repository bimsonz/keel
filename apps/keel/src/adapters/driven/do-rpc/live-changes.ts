import type { ProjectId } from "@keeltown/core/kernel";
import { LiveChanges } from "@keeltown/core/ports";
import { Layer } from "effect";
import { ProjectCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Project DO methods `LiveChanges` calls (`project:<id>`), answering Exit envelopes. */
export interface LiveChangesStub {
  liveChanges(): Promise<unknown>;
}

/** `LiveChanges` over each project's Project DO, which keeps the index. */
export function LiveChangesRpc(
  project: (projectId: ProjectId) => LiveChangesStub,
): Layer.Layer<LiveChanges> {
  return Layer.succeed(
    LiveChanges,
    LiveChanges.of({
      of: (projectId) =>
        callObject(ProjectCodecs.liveChanges, () => project(projectId).liveChanges()),
    }),
  );
}
