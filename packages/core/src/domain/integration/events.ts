import { Schema } from "effect";
import {
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  ContentHash,
  InstantSchema,
  ProjectId,
  Tier,
  VerdictId,
} from "../kernel/index.ts";

/**
 * Who a failed batch is blamed on: one member, a refused composition
 * (`textual`), every subset passing while the union fails (`interaction`),
 * the infrastructure (`infra`), or nobody yet (`unattributed`: a
 * multi-member failure `attribute` could not pin, the only kind bisected).
 */
export const BatchAttribution = Schema.Union([
  ChangeId,
  Schema.Literals(["textual", "interaction", "infra", "unattributed"]),
]);
export type BatchAttribution = typeof BatchAttribution.Type;

export const BatchFormed = Schema.TaggedStruct("BatchFormed", {
  batchId: BatchId,
  laneId: Schema.String,
  members: Schema.Array(ChangeId),
  base: CommitSha,
  attempt: Schema.Int,
  chainEpoch: Schema.Int,
  /** Optional only so events from before it was added still decode; the Lane always sets it. */
  projectId: Schema.optional(ProjectId),
  /** Changes the batch was verified on top of that trunk does not hold yet (its speculation chain). */
  predecessors: Schema.optional(Schema.Array(ChangeId)),
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
  /** What the Trunk DO needs to promote the batch: optional only so older events still decode. */
  members: Schema.optional(Schema.Array(ChangeId)),
  base: Schema.optional(CommitSha),
  predecessors: Schema.optional(Schema.Array(ChangeId)),
  /** Carried unchanged from the batch's `VerdictIssued.verified`. Absent means true. */
  verified: Schema.optional(Schema.Boolean),
});
export const BatchFailed = Schema.TaggedStruct("BatchFailed", {
  batchId: BatchId,
  candidateId: Schema.optional(CandidateId),
  verdictId: VerdictId,
  attribution: BatchAttribution,
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
  /** False when any batch in the group was unverified; absent means every one was verified. */
  verified: Schema.optional(Schema.Boolean),
});
export const PromotionDeclined = Schema.TaggedStruct("PromotionDeclined", {
  projectId: ProjectId,
  batchId: BatchId,
  /** `frozen`: the batch was in the group a freeze stopped, and the operator's resume drops it. */
  reason: Schema.Literals(["commutation-failed", "frozen"]),
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
  /** The head the operator confirms trunk is at; optional only so older events still decode. */
  head: Schema.optional(CommitSha),
});
/** A project exists: its Project DO, trunk, lanes and subject registry are keyed by `projectId` from here on. */
export const ProjectCreated = Schema.TaggedStruct("ProjectCreated", {
  projectId: ProjectId,
  name: Schema.String,
  by: Schema.String,
});
/** One setting an operator changed: its name, and its JSON value before and after. */
export const SettingChange = Schema.Struct({
  field: Schema.String,
  from: Schema.Unknown,
  to: Schema.Unknown,
});
/** An operator changed the project's settings: every change is audited, e.g. turning verification off. */
export const ProjectSettingsChanged = Schema.TaggedStruct("ProjectSettingsChanged", {
  projectId: ProjectId,
  changes: Schema.Array(SettingChange),
  by: Schema.String,
});
/** The trunk's first known head, from the project's seed or an operator. Nothing promotes before it. */
export const TrunkInitialized = Schema.TaggedStruct("TrunkInitialized", {
  projectId: ProjectId,
  head: CommitSha,
  by: Schema.String,
});
/**
 * The write-ahead log entry (ADR 0003): the group about to be pushed, written
 * before the compose. It is resolved by exactly one `TrunkAdvanced` or `PromotionFrozen`.
 */
export const PromotionStarted = Schema.TaggedStruct("PromotionStarted", {
  projectId: ProjectId,
  groupId: Schema.String,
  old: CommitSha,
  members: Schema.Array(ChangeId),
  batches: Schema.Array(BatchId),
  proofIds: Schema.Array(Schema.String),
  committerTime: InstantSchema,
});
/** The group's composed commit, recorded before the first push: every retry pushes this SHA, never a recompose. */
export const PromotionComposed = Schema.TaggedStruct("PromotionComposed", {
  projectId: ProjectId,
  groupId: Schema.String,
  sha: CommitSha,
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
  ProjectCreated,
  ProjectSettingsChanged,
  TrunkInitialized,
  PromotionStarted,
  PromotionComposed,
  AuditCompleted,
]);
export type IntegrationEvent = typeof IntegrationEvent.Type;
