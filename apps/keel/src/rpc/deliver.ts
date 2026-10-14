import { CandidateId, CommitSha, ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";

/**
 * One Deliver run: deploy trunk's new commit `to` on the project's deploy
 * target, from the preview of the candidates that landed (in group order).
 * Workflow payload, so Effect Schema; the instance id is
 * `deliver-<projectId>-<to>`, so a TrunkAdvanced delivered again starts
 * nothing new.
 */
export const DeliverJob = Schema.Struct({
  projectId: ProjectId,
  to: CommitSha,
  candidates: Schema.Array(CandidateId),
});
export type DeliverJob = typeof DeliverJob.Type;

/** Deliver's instance id for trunk reaching `to` on the project. */
export const deliverInstanceId = (projectId: ProjectId, to: CommitSha): string =>
  `deliver-${projectId}-${to}`;
