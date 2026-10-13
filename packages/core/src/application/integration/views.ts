import { Effect, Option } from "effect";
import type { CommitSha, Instant, ProjectId } from "../../domain/kernel/index.ts";
import { Trunks } from "../ports/index.ts";

/**
 * The integration read models reachable from the API: a project's trunk as
 * its Trunk DO holds it. The doorway has already authorised the read on the
 * project.
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
