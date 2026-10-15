import { Schema } from "effect";
import {
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  ContentHash,
  EvidenceClass,
  InstantSchema,
  NextAction,
  ProjectId,
  Tier,
  TierChoice,
  UserId,
  VerdictId,
} from "../kernel/index.ts";
import { PushRefusedReason } from "../coordination/index.ts";
import { FlowWorld, InfraFailure, StepKind, StepOutcome } from "../verification/index.ts";

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
/**
 * What MergeBox's check found in the box once it had composed: the canary
 * planted at its start, in its environment and its file, and no token.
 */
export const BoxCheck = Schema.Struct({
  canary: Schema.Literal("found"),
  tokens: Schema.Literal("none"),
});
export type BoxCheck = typeof BoxCheck.Type;
export const CandidateAssembled = Schema.TaggedStruct("CandidateAssembled", {
  candidateId: CandidateId,
  batchId: BatchId,
  treeSha: CommitSha,
  composer: Schema.Literals(["gitcore", "mergebox"]),
  tier: Tier,
  tierReason: Schema.String,
  /** Set for a candidate MergeBox composed: what its check found. */
  boxCheck: Schema.optional(BoxCheck),
});
export const VerificationStarted = Schema.TaggedStruct("VerificationStarted", {
  candidateId: CandidateId,
  batchId: BatchId,
  instanceId: Schema.String,
  planHash: ContentHash,
});
const stepStarted = {
  stepId: Schema.NonEmptyString,
  kind: StepKind,
  /** Where it runs: tier 2 is a box, tier 0 the Worker. */
  tier: TierChoice,
  world: Schema.optional(FlowWorld),
};
const stepFinished = {
  stepId: Schema.NonEmptyString,
  world: Schema.optional(FlowWorld),
  outcome: StepOutcome,
  evidenceClass: EvidenceClass,
  tier: TierChoice,
  /** The runner's own measure of the step. */
  durationMs: Schema.Finite,
  /** The evidence the step stored, as the verdict cites it. */
  resultRef: Schema.optional(Schema.String),
  /** Why the runner gave no judgement: the step abstained for it. */
  failure: Schema.optional(InfraFailure),
};
/**
 * A step of the batch's plan started on its candidate, in `world` inside a
 * worlds node. Committed by the Lane DO while the batch verifies, fenced on its
 * attempt and chain epoch; the record's own `at` is when.
 */
export const VerificationStepStarted = Schema.TaggedStruct("VerificationStepStarted", {
  batchId: BatchId,
  candidateId: CandidateId,
  ...stepStarted,
});
/**
 * The step's result, the one `verdict/1` reads, so it equals the verdict's
 * line for the step. A step started and never finished (its batch cancelled,
 * or its instance stopped) is closed by the event that ended its batch.
 */
export const VerificationStepFinished = Schema.TaggedStruct("VerificationStepFinished", {
  batchId: BatchId,
  candidateId: CandidateId,
  ...stepFinished,
});
/** A step's start or its result, as KeelVerify reports it to the lane, which adds the batch and candidate. */
export const StepReported = Schema.Union([
  Schema.TaggedStruct("Started", stepStarted),
  Schema.TaggedStruct("Finished", stepFinished),
]);
export type StepReported = typeof StepReported.Type;
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
  /**
   * `frozen`: the batch was in the group a freeze stopped, and the operator's resume drops it.
   * `pack-too-large` and `repo-bytes-quota`: Artifacts refused the group's push, and trunk did not move.
   */
  reason: Schema.Literals(["commutation-failed", "frozen", ...PushRefusedReason.literals]),
  /** The members to verify again. Empty when a refused push bounces them instead. */
  reverify: Schema.Array(ChangeId),
  /** What the members' agents can do; always set when a push was refused. */
  nextActions: Schema.optional(Schema.Array(NextAction)),
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
/** Whoever governs the project changed its settings, a person or an agent in a namespace of its own: every change is audited, e.g. turning verification off. */
export const ProjectSettingsChanged = Schema.TaggedStruct("ProjectSettingsChanged", {
  projectId: ProjectId,
  changes: Schema.Array(SettingChange),
  by: Schema.String,
});
/**
 * Where a project's trunk started, kept for good: Keel's own first
 * commit for an empty project; the public Git URL an import took, with the
 * upstream branch that came; the project a fork was taken from; or the
 * template it was made from. `commit` is trunk's first head, which is the
 * history Keel did not write: what a reader checks the start against.
 */
export const TrunkOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("empty") }),
  Schema.Struct({
    kind: Schema.Literal("imported"),
    url: Schema.NonEmptyString,
    /** The upstream branch that came, by its full ref name. */
    ref: Schema.NonEmptyString,
    commit: CommitSha,
  }),
  Schema.Struct({ kind: Schema.Literal("forked"), project: ProjectId, commit: CommitSha }),
  Schema.Struct({
    kind: Schema.Literal("template"),
    name: Schema.NonEmptyString,
    commit: CommitSha,
  }),
]);
export type TrunkOrigin = typeof TrunkOrigin.Type;

/**
 * The trunk's first known head, from the project's start. Nothing promotes
 * before it. `origin` says where that head came from; absent on a trunk
 * initialized before origins were kept.
 */
export const TrunkInitialized = Schema.TaggedStruct("TrunkInitialized", {
  projectId: ProjectId,
  head: CommitSha,
  by: Schema.String,
  origin: Schema.optional(TrunkOrigin),
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
/** The upstream an imported trunk syncs from: the URL and branch its import took, as its origin names them. */
export const SyncUpstream = Schema.Struct({
  url: Schema.NonEmptyString,
  /** The upstream branch, by its full ref name. */
  ref: Schema.NonEmptyString,
});
export type SyncUpstream = typeof SyncUpstream.Type;

/**
 * The write-ahead entry of a sync from upstream: an owner asked for trunk's
 * main to move from `from` to `to`, the upstream branch's head, which
 * descends from it. Written before the move, and resolved by exactly one
 * `TrunkSynced` or `PromotionFrozen`.
 */
export const TrunkSyncStarted = Schema.TaggedStruct("TrunkSyncStarted", {
  projectId: ProjectId,
  from: CommitSha,
  to: CommitSha,
  by: Schema.String,
  upstream: SyncUpstream,
});
/**
 * Trunk's main moved forward to its upstream branch's head, each upstream
 * commit kept as upstream made it: no change landed, so no change is named.
 */
export const TrunkSynced = Schema.TaggedStruct("TrunkSynced", {
  projectId: ProjectId,
  from: CommitSha,
  to: CommitSha,
  by: Schema.String,
  upstream: SyncUpstream,
  /** Trunk's height after the sync, counted as an advance is. */
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export const AuditCompleted = Schema.TaggedStruct("AuditCompleted", {
  projectId: ProjectId,
  head: CommitSha,
  outcome: Schema.Literals(["green", "red"]),
  suspects: Schema.Array(ChangeId),
  runRef: Schema.String,
});

/**
 * Speculation cancelled a batch behind a failed one, `because`, before it
 * promoted: it left the queue if it was there, and the trunk remembers it, so
 * a verdict for it that arrives later is refused and the batch never promotes.
 */
export const BatchDropped = Schema.TaggedStruct("BatchDropped", {
  projectId: ProjectId,
  batchId: BatchId,
  because: BatchId,
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
  TrunkSyncStarted,
  TrunkSynced,
  BatchDropped,
  VerificationStepStarted,
  VerificationStepFinished,
]);
export type IntegrationEvent = typeof IntegrationEvent.Type;
