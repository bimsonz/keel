import type { Effect } from "effect";
import type { AgentToken } from "../../domain/identity/index.ts";
import type {
  Batch,
  CandidateNotFound,
  ProjectNotFound,
  PromotionState,
} from "../../domain/integration/index.ts";
import type { CandidateId, CommitSha, Instant, ProjectId } from "../../domain/kernel/index.ts";
import { stub } from "../not-implemented.ts";
import type { EntityStore } from "../ports/index.ts";

export * from "./create-project.ts";
export * from "./lane.ts";
export * from "./project-repos.ts";
export * from "./project-settings.ts";
export * from "./repo.ts";
export * from "./trunk.ts";

/** integration read models reachable from the API. Keel owns the Lane and Trunk DOs behind them. */

export interface TrunkView {
  readonly projectId: ProjectId;
  readonly head: CommitSha;
  readonly advancedAt: Instant;
  readonly promotion: PromotionState;
  readonly redCount: number;
}

export interface LaneView {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly queued: number;
  readonly inFlight: number;
}

export const getCandidate: (
  principal: AgentToken,
  candidateId: CandidateId,
) => Effect.Effect<Batch, CandidateNotFound, EntityStore> = stub("integration/getCandidate");

export const listLanes: (
  principal: AgentToken,
  projectId: ProjectId,
) => Effect.Effect<readonly LaneView[], ProjectNotFound, EntityStore> =
  stub("integration/listLanes");

export const getTrunk: (
  principal: AgentToken,
  projectId: ProjectId,
) => Effect.Effect<TrunkView, ProjectNotFound, EntityStore> = stub("integration/getTrunk");
