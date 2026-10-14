import type { ProjectId } from "@keeltown/core/kernel";
import { LiveChanges } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { LiveNearRead, ProjectCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Project DO methods `LiveChanges` calls (`project:<id>`), answering Exit envelopes. */
export interface LiveChangesStub {
  liveNear(read: typeof LiveNearRead.Encoded): Promise<unknown>;
}

const encodeNear = Schema.encodeSync(LiveNearRead);

/** `LiveChanges` over each project's Project DO, which keeps the index. */
export function LiveChangesRpc(
  project: (projectId: ProjectId) => LiveChangesStub,
): Layer.Layer<LiveChanges> {
  return Layer.succeed(
    LiveChanges,
    LiveChanges.of({
      near: (projectId, self, intent) =>
        callObject(ProjectCodecs.liveNear, () =>
          project(projectId).liveNear(encodeNear({ self, intent })),
        ),
    }),
  );
}
