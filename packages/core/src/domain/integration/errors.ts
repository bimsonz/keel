import { Schema } from "effect";
import {
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  NextAction,
  ProjectId,
} from "../kernel/index.ts";
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

/** Trunk did not start from an import, so it has no upstream to sync from. */
export class NotImported extends Schema.TaggedError<NotImported>()("NotImported", {
  projectId: ProjectId,
}) {}

/**
 * Upstream's head does not descend from trunk's: trunk holds commits upstream
 * lacks, or upstream's history was rewritten. Nothing was moved.
 */
export class NotFastForward extends Schema.TaggedError<NotFastForward>()("NotFastForward", {
  projectId: ProjectId,
  trunk: CommitSha,
  upstream: CommitSha,
}) {}

/**
 * A cancel came too late: the batch is in the group being pushed
 * (`promoting`), or a member of it already landed (`promoted`). It lands or
 * fails with that group, and its members are not queued again.
 */
export class CancelTooLate extends Schema.TaggedError<CancelTooLate>()("CancelTooLate", {
  projectId: ProjectId,
  batchId: BatchId,
  reason: Schema.Literals(["promoting", "promoted"]),
}) {}

/** The command is not valid in the trunk's current promotion phase. */
export class PromotionStateRefused extends Schema.TaggedError<PromotionStateRefused>()(
  "PromotionStateRefused",
  {
    projectId: ProjectId,
    phase: PromotionState,
    command: Schema.String,
  },
) {}

/**
 * The composer reported a chain whose members are not the group's, in the
 * group's order: a composer defect, so nothing is recorded or pushed.
 */
export class CompositionMismatch extends Schema.TaggedError<CompositionMismatch>()(
  "CompositionMismatch",
  {
    projectId: ProjectId,
    groupId: Schema.String,
    expected: Schema.Array(ChangeId),
    got: Schema.Array(ChangeId),
    nextActions: Schema.Array(NextAction),
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
    /** What failed where the composer could see it (MergeBox's stage, exit and stderr's tail), for the evidence; never a remote. */
    detail: Schema.optional(Schema.String),
    /** For a gate with no room (`box-unavailable`), how long until its soonest lease ends: the lane forms nothing before then unless a box is freed sooner. */
    retryAfterMs: Schema.optional(Schema.Number),
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
