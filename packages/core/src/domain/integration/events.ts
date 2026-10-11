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
  UserId,
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
/** One member's commit in a group's composed chain on trunk. */
export const MemberCommit = Schema.Struct({
  changeId: ChangeId,
  commitSha: CommitSha,
});
export type MemberCommit = typeof MemberCommit.Type;

/**
 * How one member landed: its commit on trunk (the one carrying its trailers),
 * the candidate it was verified in, and the proof that let its batch land.
 * Everything its Change DO needs to commit `ChangeLanded`.
 */
export const MemberLanding = Schema.Struct({
  changeId: ChangeId,
  commitSha: CommitSha,
  candidateId: CandidateId,
  proofId: Schema.String,
});
export type MemberLanding = typeof MemberLanding.Type;

export const TrunkAdvanced = Schema.TaggedStruct("TrunkAdvanced", {
  projectId: ProjectId,
  from: CommitSha,
  to: CommitSha,
  groupId: Schema.String,
  /** Every member of the group, in group order, each with its own landing. */
  landings: Schema.Array(MemberLanding),
  /** False when any batch in the group was unverified; absent means every one was verified. */
  verified: Schema.optional(Schema.Boolean),
  /** Trunk's height after this advance: TrunkInitialized is height 0, and each advance adds 1. */
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export const PromotionDeclined = Schema.TaggedStruct("PromotionDeclined", {
  projectId: ProjectId,
  batchId: BatchId,
  /** `frozen`: the batch was in the group a freeze stopped, and the operator's resume drops it. */
  reason: Schema.Literals(["commutation-failed", "frozen"]),
  reverify: Schema.Array(ChangeId),
});
/**
 * Why promotion froze: the head moved under the flush (`head-moved`), a
 * recompose disagreed with the SHA already recorded (`recompose-mismatch`), or
 * the head read back after the push was neither the old nor the composed one
 * (`readback-mismatch`).
 */
export const PromotionFrozenReason = Schema.Literals([
  "head-moved",
  "recompose-mismatch",
  "readback-mismatch",
]);
export type PromotionFrozenReason = typeof PromotionFrozenReason.Type;

export const PromotionFrozen = Schema.TaggedStruct("PromotionFrozen", {
  projectId: ProjectId,
  groupId: Schema.String,
  expected: CommitSha,
  observed: CommitSha,
  /** Always set by the Trunk; optional only so an older event still decodes. */
  reason: Schema.optional(PromotionFrozenReason),
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
  /** The project this one was forked from, when it is a fork. */
  forkedFrom: Schema.optional(ProjectId),
});
/** A project and its repos are gone, deleted by an owner of its org or with the org. */
export const ProjectDeleted = Schema.TaggedStruct("ProjectDeleted", {
  projectId: ProjectId,
  by: UserId,
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
  /** Each member's commit in the composed chain, in group order: the commits the members land as. */
  commits: Schema.Array(MemberCommit),
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
  ProjectDeleted,
  ProjectSettingsChanged,
  TrunkInitialized,
  PromotionStarted,
  PromotionComposed,
  AuditCompleted,
]);
export type IntegrationEvent = typeof IntegrationEvent.Type;
