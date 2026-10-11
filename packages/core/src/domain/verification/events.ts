import { Schema } from "effect";
import {
  BatchId,
  CandidateId,
  ChangeId,
  ConflictId,
  ContentHash,
  DecisionId,
  EntityRef,
  EscalationId,
  GuardId,
  ProbeId,
  SubjectId,
  VerdictId,
} from "../kernel/index.ts";
import { Move, Predicate } from "../coordination/index.ts";
import { ConflictKind, ConflictOrigin, Party, World } from "./conflict.ts";
import { VerdictOutcome } from "./plan.ts";

export const ConflictSuspected = Schema.TaggedStruct("ConflictSuspected", {
  conflictId: ConflictId,
  kind: ConflictKind,
  parties: Schema.Array(Party),
  subjectId: Schema.optional(SubjectId),
  predicate: Schema.optional(Predicate),
  /** Absent means `fallout`; `opinion` is a decision model's suspicion, which only a probe or a person settles. */
  origin: Schema.optional(ConflictOrigin),
});
export const ProbeDrafted = Schema.TaggedStruct("ProbeDrafted", {
  probeId: ProbeId,
  conflictId: ConflictId,
  attempts: Schema.Int,
  bundleHash: ContentHash,
});
export const ProbeRan = Schema.TaggedStruct("ProbeRan", {
  probeId: ProbeId,
  conflictId: ConflictId,
  world: World,
  run: Schema.Int,
  outcome: Schema.Literals(["pass", "fail", "n/a"]),
  resultRef: Schema.String,
});
export const ProbeDiscarded = Schema.TaggedStruct("ProbeDiscarded", {
  probeId: ProbeId,
  reason: Schema.Literals(["non-discriminating", "unstable", "draft-failed"]),
  /**
   * Optional only so older events still decode. Always set: a probe whose
   * drafts all failed begins with this event, and it is the only one naming its conflict.
   */
  conflictId: Schema.optional(ConflictId),
});
export const ConflictProven = Schema.TaggedStruct("ConflictProven", {
  conflictId: ConflictId,
  evidence: Schema.Union([
    Schema.TaggedStruct("probe", { probeId: ProbeId }),
    Schema.TaggedStruct("guard", { guardId: GuardId }),
    Schema.TaggedStruct("merge-refused", { batchId: BatchId }),
    /** Every subset of the batch passed and the union failed: the Lane DO's own runs are the proof. */
    Schema.TaggedStruct("interaction", { batchId: BatchId }),
  ]),
});
export const ConflictDismissed = Schema.TaggedStruct("ConflictDismissed", {
  conflictId: ConflictId,
  evidence: Schema.String,
});
export const ConflictEscalated = Schema.TaggedStruct("ConflictEscalated", {
  conflictId: ConflictId,
  escalationId: EscalationId,
  reason: Schema.Literals(["human-class", "unprovable"]),
});
export const ConflictResolved = Schema.TaggedStruct("ConflictResolved", {
  conflictId: ConflictId,
  move: Move,
  decisionId: Schema.optional(DecisionId),
});
export const GuardAdmitted = Schema.TaggedStruct("GuardAdmitted", {
  guardId: GuardId,
  probeId: ProbeId,
  conflictId: ConflictId,
  runs: Schema.Int,
});
export const GuardRetired = Schema.TaggedStruct("GuardRetired", {
  guardId: GuardId,
  decisionId: DecisionId,
});
export const GuardFailed = Schema.TaggedStruct("GuardFailed", {
  guardId: GuardId,
  batchId: BatchId,
  candidateId: CandidateId,
  world: World,
});
export const VerdictIssued = Schema.TaggedStruct("VerdictIssued", {
  verdictId: VerdictId,
  subject: Schema.Union([ChangeId, BatchId]),
  outcome: VerdictOutcome,
  evidence: Schema.Array(Schema.String),
  /**
   * The plan the verdict was reached under; it always resolves to a plan.
   * Absent means no plan: a Precheck refusal, a ruling-class verdict reached
   * before any plan was compiled. Never a fabricated hash.
   */
  planHash: Schema.optional(ContentHash),
  /**
   * False when the project's verification is off (`ProjectSettings.verification`):
   * the verdict was reached without running the plan. Absent means true.
   */
  verified: Schema.optional(Schema.Boolean),
});
export const EscalationRaised = Schema.TaggedStruct("EscalationRaised", {
  escalationId: EscalationId,
  question: Schema.NonEmptyString,
  options: Schema.Array(Schema.String),
  consequences: Schema.Array(Schema.String),
  about: EntityRef,
});
export const EscalationWithdrawn = Schema.TaggedStruct("EscalationWithdrawn", {
  escalationId: EscalationId,
  reason: Schema.String,
});

export const VerificationEvent = Schema.Union([
  ConflictSuspected,
  ProbeDrafted,
  ProbeRan,
  ProbeDiscarded,
  ConflictProven,
  ConflictDismissed,
  ConflictEscalated,
  ConflictResolved,
  GuardAdmitted,
  GuardRetired,
  GuardFailed,
  VerdictIssued,
  EscalationRaised,
  EscalationWithdrawn,
]);
export type VerificationEvent = typeof VerificationEvent.Type;
