import type { Effect } from "effect";
import type { AgentToken } from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import type { ProjectId } from "../../domain/kernel/index.ts";
import { stub } from "../not-implemented.ts";
import type { EntityStore } from "../ports/index.ts";

export * from "./create-project.ts";
export * from "./lane.ts";
export * from "./project-repos.ts";
export * from "./project-settings.ts";
export * from "./project-source.ts";
export * from "./project-visibility.ts";
export * from "./repo.ts";
export * from "./trunk.ts";
export * from "./views.ts";

export interface LaneView {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly queued: number;
  readonly inFlight: number;
}

export const listLanes: (
  principal: AgentToken,
  projectId: ProjectId,
) => Effect.Effect<readonly LaneView[], ProjectNotFound, EntityStore> =
  stub("integration/listLanes");
