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
  idPattern,
  NextAction,
  ProbeId,
  SubjectId,
  VerdictId,
} from "../kernel/index.ts";
import { Move, Predicate, SubjectKey } from "../coordination/index.ts";
import {
  ConflictKind,
  ConflictOrigin,
  Party,
  SuspectEffect,
  SuspectPremise,
  World,
} from "./conflict.ts";
import { EscalationCategory, EscalationEvidence, EscalationOption } from "./escalation.ts";
import { VerdictOutcome } from "./plan.ts";

export const ConflictSuspected = Schema.TaggedStruct("ConflictSuspected", {
  conflictId: ConflictId,
  kind: ConflictKind,
  parties: Schema.Array(Party),
  subjectId: Schema.optional(SubjectId),
  /** The subject's key, which addresses its Subject DO. Only with `subjectId`; absent on older events. */
  subjectKey: Schema.optional(SubjectKey),
  predicate: Schema.optional(Predicate),
  /** Absent means `fallout`; `opinion` is a decision model's suspicion, which only a probe or a person settles. */
  origin: Schema.optional(ConflictOrigin),
  /** The premise at stake, and its holder. Without it and `effect`, no probe is drafted: the conflict escalates as unprovable. */
  premise: Schema.optional(SuspectPremise),
  /** The effect against the premise, and the change making it. */
  effect: Schema.optional(SuspectEffect),
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
/**
 * A suite's run in one world of a conflict's matrix, run 1 to 3: `suite:trunk`,
 * the project's suite on trunk, or `suite:<changeId>`, a change's own.
 */
export const WorldCheck = Schema.String.check(
  Schema.isPattern(new RegExp(`^suite:(?:trunk|${idPattern("chg").source.slice(1, -1)})$`)),
);
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * One cell of a conflict's world matrix filled by a project's suite rather
 * than its probe: a fact of a conflict whose probe was drafted, which stays
 * in the state it is in. An `n/a` cell says why the suite did not apply.
 */
export const WorldCheckRan = Schema.TaggedStruct("WorldCheckRan", {
  conflictId: ConflictId,
  world: World,
  check: WorldCheck,
  run: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  outcome: Schema.Literals(["pass", "fail", "n/a"]),
  counts: Schema.optional(Schema.Struct({ passed: Count, failed: Count, skipped: Count })),
  reason: Schema.optional(Schema.NonEmptyString),
}).check(
  Schema.makeFilter(
    (e) => e.outcome !== "n/a" || e.reason !== undefined || "an n/a check says why",
  ),
);
/**
 * Why no draft of a probe was admitted to calibrate: the
 * model abstained, the repairs ran out, a run of the matrix never completed,
 * the conflict names no premise and effect to draft against, a party submitted
 * no commit to build a world from, a party is gone, or the worlds could not be
 * built. `schema` and `truncated` are a reply that did not fit the slots'
 * schema and one cut at the token limit: both are repaired now, so nothing
 * emits them, and they stay so older events decode.
 */
export const DraftFailure = Schema.Literals([
  "schema",
  "truncated",
  "abstained",
  "repairs-exhausted",
  "incomplete",
  "no-propositions",
  "no-submission",
  "party-gone",
  "worlds-unbuildable",
]);
export type DraftFailure = typeof DraftFailure.Type;

export const ProbeDiscarded = Schema.TaggedStruct("ProbeDiscarded", {
  probeId: ProbeId,
  /** `run-failed`: the probe's run ended before its matrix was complete. */
  reason: Schema.Literals(["non-discriminating", "unstable", "draft-failed", "run-failed"]),
  /**
   * Optional only so older events still decode. Always set: a probe whose
   * drafts all failed begins with this event, and it is the only one naming its conflict.
   */
  conflictId: Schema.optional(ConflictId),
  /** Why the drafts failed, with `draft-failed` only. */
  detail: Schema.optional(DraftFailure),
}).check(
  Schema.makeFilter(
    (e) =>
      e.detail === undefined ||
      e.reason === "draft-failed" ||
      "a detail is given only when the drafts failed",
  ),
);
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
  /** The parties the ruling went against, never empty: each bounces by this decision, and every other party resumes. */
  against: Schema.optional(Schema.Array(ChangeId)),
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
/**
 * A guard failing is a fact of what it ran against: a batch's candidate at
 * the Lane DO, or, at Precheck, the change itself, with no batch or candidate.
 */
export const GuardFailed = Schema.TaggedStruct("GuardFailed", {
  guardId: GuardId,
  batchId: Schema.optional(BatchId),
  candidateId: Schema.optional(CandidateId),
  changeId: Schema.optional(ChangeId),
  world: World,
}).check(
  Schema.makeFilter(
    (e) =>
      e.changeId !== undefined ||
      (e.batchId !== undefined && e.candidateId !== undefined) ||
      "a guard fails against a change, or against a batch and its candidate",
  ),
);
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
  /**
   * The remedy, named by the issuer that knows it (the Lane for a refused
   * composition or bundle, KeelVerify for a failing test). The Change DO copies
   * it onto `ChangeBounced`, and falls back to its own default only when absent.
   */
  nextActions: Schema.optional(Schema.Array(NextAction)),
});
/**
 * A question for a person: at least two options with unique ids, each with its
 * consequence, the default among them, the evidence by class, and the
 * precedents that bear on it.
 */
export const EscalationRaised = Schema.TaggedStruct("EscalationRaised", {
  escalationId: EscalationId,
  question: Schema.NonEmptyString,
  options: Schema.Array(EscalationOption),
  about: EntityRef,
  category: EscalationCategory,
  evidence: Schema.Array(EscalationEvidence),
  precedents: Schema.Array(DecisionId),
  default: Schema.NonEmptyString,
});
export const EscalationWithdrawn = Schema.TaggedStruct("EscalationWithdrawn", {
  escalationId: EscalationId,
  reason: Schema.String,
});
/**
 * The person asked first has had their turn and the escalation is still open:
 * its namespace's maintainers are asked too. Nothing is reassigned, and the
 * person asked first may still answer.
 */
export const EscalationWidened = Schema.TaggedStruct("EscalationWidened", {
  escalationId: EscalationId,
});

export const VerificationEvent = Schema.Union([
  ConflictSuspected,
  ProbeDrafted,
  ProbeRan,
  WorldCheckRan,
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
  EscalationWidened,
]);
export type VerificationEvent = typeof VerificationEvent.Type;
