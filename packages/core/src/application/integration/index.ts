import type { Effect } from "effect";
import type { AgentToken } from "../../domain/identity/index.ts";
import type { ProjectNotFound, PromotionState } from "../../domain/integration/index.ts";
import type { CommitSha, Instant, ProjectId } from "../../domain/kernel/index.ts";
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

/** integration read models reachable from the API. Keel owns the Lane and Trunk DOs behind them. */

export interface TrunkView {
  readonly projectId: ProjectId;
  readonly head: CommitSha;
  readonly advancedAt: Instant;
  readonly promotion: PromotionState;
}

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

export const getTrunk: (
  principal: AgentToken,
  projectId: ProjectId,
) => Effect.Effect<TrunkView, ProjectNotFound, EntityStore> = stub("integration/getTrunk");
