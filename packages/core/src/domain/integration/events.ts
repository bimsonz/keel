import { Schema } from "effect";
import {
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  ContentHash,
  ProjectId,
  Tier,
  VerdictId,
} from "../kernel/index.ts";

export const BatchFormed = Schema.TaggedStruct("BatchFormed", {
  batchId: BatchId,
  laneId: Schema.String,
  members: Schema.Array(ChangeId),
  base: CommitSha,
  attempt: Schema.Int,
  chainEpoch: Schema.Int,
});
export const CandidateAssembled = Schema.TaggedStruct("CandidateAssembled", {
  candidateId: CandidateId,
  batchId: BatchId,
  treeSha: CommitSha,
  composer: Schema.Literals(["gitcore", "mergebox"]),
  tier: Tier,
  tierReason: Schema.String,
});
export const VerificationStarted = Schema.TaggedStruct("VerificationStarted", {
  candidateId: CandidateId,
  batchId: BatchId,
  instanceId: Schema.String,
  planHash: ContentHash,
});
export const BatchVerified = Schema.TaggedStruct("BatchVerified", {
  batchId: BatchId,
  candidateId: CandidateId,
  verdictId: VerdictId,
});
export const BatchFailed = Schema.TaggedStruct("BatchFailed", {
  batchId: BatchId,
  candidateId: Schema.optional(CandidateId),
  verdictId: VerdictId,
  attribution: Schema.Union([ChangeId, Schema.Literals(["textual", "interaction", "infra"])]),
});
export const CandidateBisected = Schema.TaggedStruct("CandidateBisected", {
  candidateId: CandidateId,
  batchId: BatchId,
  into: Schema.Array(BatchId),
});
export const CandidateInvalidated = Schema.TaggedStruct("CandidateInvalidated", {
  candidateId: CandidateId,
  batchId: BatchId,
  reason: Schema.Literal("head-moved"),
});
export const CandidatePromoted = Schema.TaggedStruct("CandidatePromoted", {
  candidateId: CandidateId,
  batchId: BatchId,
  trunkSha: CommitSha,
});
export const TrunkAdvanced = Schema.TaggedStruct("TrunkAdvanced", {
  projectId: ProjectId,
  from: CommitSha,
  to: CommitSha,
  groupId: Schema.String,
  members: Schema.Array(ChangeId),
  proofIds: Schema.Array(Schema.String),
});
export const PromotionDeclined = Schema.TaggedStruct("PromotionDeclined", {
  projectId: ProjectId,
  batchId: BatchId,
  reason: Schema.Literal("commutation-failed"),
  reverify: Schema.Array(ChangeId),
});
export const PromotionFrozen = Schema.TaggedStruct("PromotionFrozen", {
  projectId: ProjectId,
  groupId: Schema.String,
  expected: CommitSha,
  observed: CommitSha,
});
export const PromotionResumed = Schema.TaggedStruct("PromotionResumed", {
  projectId: ProjectId,
  by: Schema.String,
});
export const AuditCompleted = Schema.TaggedStruct("AuditCompleted", {
  projectId: ProjectId,
  head: CommitSha,
  outcome: Schema.Literals(["green", "red"]),
  suspects: Schema.Array(ChangeId),
  runRef: Schema.String,
});

export const IntegrationEvent = Schema.Union([
  BatchFormed,
  CandidateAssembled,
  VerificationStarted,
  BatchVerified,
  BatchFailed,
  CandidateBisected,
  CandidateInvalidated,
  CandidatePromoted,
  TrunkAdvanced,
  PromotionDeclined,
  PromotionFrozen,
  PromotionResumed,
  AuditCompleted,
]);
export type IntegrationEvent = typeof IntegrationEvent.Type;
