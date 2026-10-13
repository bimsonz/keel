import { Effect, Option } from "effect";
import type { CommitSha, Instant, ProjectId } from "../../domain/kernel/index.ts";
import { Lanes, Trunks } from "../ports/index.ts";

/**
 * The integration read models reachable from the API: a project's trunk and
 * its lanes as their own objects hold them. The doorway has already
 * authorised the read on the project.
 */

export interface TrunkView {
  readonly projectId: ProjectId;
  readonly head: CommitSha;
  /** When trunk's head last changed. */
  readonly advancedAt: Instant;
  /** Promotion has stopped on a trunk that did not read as Keel left it, until an operator resumes it. */
  readonly frozen: boolean;
}

/** The project's trunk, or none while it has no head yet. */
export const readTrunk = (
  projectId: ProjectId,
): Effect.Effect<Option.Option<TrunkView>, never, Trunks> =>
  Effect.map(
    Effect.flatMap(Trunks, (trunks) => trunks.view(projectId)),
    Option.map((trunk) => ({
      projectId,
      head: trunk.head,
      advancedAt: trunk.advancedAt,
      frozen: trunk.phase === "frozen",
    })),
  );

export interface LaneView {
  /** The lane's id, as its events name it. */
  readonly id: string;
  readonly projectId: ProjectId;
  /** Changes queued and not yet in a batch. */
  readonly queued: number;
  /** Changes in the batch in flight: formed, and not yet landed or sent back. */
  readonly inFlight: number;
}

/** The project's lanes: one today. */
export const readLanes = (projectId: ProjectId): Effect.Effect<readonly LaneView[], never, Lanes> =>
  Effect.map(
    Effect.flatMap(Lanes, (lanes) => lanes.view(projectId)),
    (lanes) => lanes.map((lane) => ({ ...lane, projectId })),
  );
