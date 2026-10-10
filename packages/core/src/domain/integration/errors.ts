import { Schema } from "effect";
import { CandidateId, CommitSha, ProjectId } from "../kernel/index.ts";

export class CandidateNotFound extends Schema.TaggedError<CandidateNotFound>()("CandidateNotFound", { candidateId: CandidateId }) {}

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", { projectId: ProjectId }) {}

/** The composer would not build the tree: GitCore refuses whenever it is unsure. */
export class CompositionRefused extends Schema.TaggedError<CompositionRefused>()("CompositionRefused", {
  reason: Schema.String,
  paths: Schema.Array(Schema.String),
}) {}

/** Trunk's head is not what the writer expected. Promotion freezes. */
export class UnexpectedHead extends Schema.TaggedError<UnexpectedHead>()("UnexpectedHead", {
  expected: CommitSha,
  observed: CommitSha,
}) {}

/** A push did not land and may be retried with the same SHA. */
export class PushRejected extends Schema.TaggedError<PushRejected>()("PushRejected", { reason: Schema.String }) {}
