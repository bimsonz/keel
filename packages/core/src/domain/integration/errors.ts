import { Schema } from "effect";
import { BatchId, CandidateId, CommitSha, ProjectId } from "../kernel/index.ts";
import { CandidateState, PromotionState } from "./batch.ts";

export class CandidateNotFound extends Schema.TaggedError<CandidateNotFound>()(
  "CandidateNotFound",
  { candidateId: CandidateId },
) {}

/** The command is not valid in the batch's current state. */
export class CandidateStateRefused extends Schema.TaggedError<CandidateStateRefused>()(
  "CandidateStateRefused",
  {
    batchId: BatchId,
    state: Schema.optional(CandidateState),
    command: Schema.String,
  },
) {}

/**
 * A verification result for another attempt or chain epoch than the batch's
 * own. Terminal: a fenced result is never retried. The Lane DO answers the
 * KeelVerify step with a non-retryable error, and an event reaction acks it as a no-op.
 */
export class ResultFenced extends Schema.TaggedError<ResultFenced>()("ResultFenced", {
  batchId: BatchId,
  attempt: Schema.Int,
  chainEpoch: Schema.Int,
}) {}

/** A batch that cannot be formed, or a failure blamed on a change that is not in it. */
export class InvalidBatch extends Schema.TaggedError<InvalidBatch>()("InvalidBatch", {
  batchId: BatchId,
  reason: Schema.String,
}) {}

/** The trunk has no known head yet: it must be initialized before anything is queued or promoted. */
export class TrunkNotInitialized extends Schema.TaggedError<TrunkNotInitialized>()(
  "TrunkNotInitialized",
  { projectId: ProjectId },
) {}

/** The command is not valid in the trunk's current promotion phase. */
export class PromotionStateRefused extends Schema.TaggedError<PromotionStateRefused>()(
  "PromotionStateRefused",
  {
    projectId: ProjectId,
    phase: PromotionState,
    command: Schema.String,
  },
) {}

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", {
  projectId: ProjectId,
}) {}

/** The composer would not build the tree: GitCore refuses whenever it is unsure. */
export class CompositionRefused extends Schema.TaggedError<CompositionRefused>()(
  "CompositionRefused",
  {
    reason: Schema.String,
    paths: Schema.Array(Schema.String),
  },
) {}

/** Trunk's head is not what the writer expected. Promotion freezes. */
export class UnexpectedHead extends Schema.TaggedError<UnexpectedHead>()("UnexpectedHead", {
  expected: CommitSha,
  observed: CommitSha,
}) {}

/** A push did not land and may be retried with the same SHA. */
export class PushRejected extends Schema.TaggedError<PushRejected>()("PushRejected", {
  reason: Schema.String,
}) {}
