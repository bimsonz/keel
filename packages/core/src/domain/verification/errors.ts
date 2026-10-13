import { Schema } from "effect";
import {
  ConflictId,
  ContentHash,
  EscalationId,
  NextAction,
  ProbeId,
  VerdictId,
} from "../kernel/index.ts";
import { EscalationState } from "../memory/index.ts";
import { ConflictState } from "./conflict.ts";
import { ProbeState } from "./probe.ts";

export class ConflictNotFound extends Schema.TaggedError<ConflictNotFound>()("ConflictNotFound", {
  conflictId: ConflictId,
}) {}

/**
 * The conflict's state does not take the command, or its facts do not
 * support it (`reason`: e.g. the lattice does not settle a dismissal, or the
 * probe is still calibrating). `nextActions` is never empty.
 */
export class ConflictStateRefused extends Schema.TaggedError<ConflictStateRefused>()(
  "ConflictStateRefused",
  {
    conflictId: ConflictId,
    state: Schema.optional(ConflictState),
    command: Schema.String,
    reason: Schema.optional(Schema.String),
    nextActions: Schema.Array(NextAction),
  },
) {}

export class ProbeNotFound extends Schema.TaggedError<ProbeNotFound>()("ProbeNotFound", {
  probeId: ProbeId,
}) {}

/** The probe's state does not take the command, or the cell contradicts one already recorded. `nextActions` is never empty. */
export class ProbeStateRefused extends Schema.TaggedError<ProbeStateRefused>()(
  "ProbeStateRefused",
  {
    probeId: ProbeId,
    state: Schema.optional(ProbeState),
    command: Schema.String,
    reason: Schema.optional(Schema.String),
    nextActions: Schema.Array(NextAction),
  },
) {}

export class VerdictNotFound extends Schema.TaggedError<VerdictNotFound>()("VerdictNotFound", {
  verdictId: VerdictId,
}) {}

export class EscalationNotFound extends Schema.TaggedError<EscalationNotFound>()(
  "EscalationNotFound",
  { escalationId: EscalationId, nextActions: Schema.Array(NextAction) },
) {}

/** A ruling named an option the escalation does not offer. `nextActions` rules each valid one. */
export class RulingOptionUnknown extends Schema.TaggedError<RulingOptionUnknown>()(
  "RulingOptionUnknown",
  { escalationId: EscalationId, option: Schema.String, nextActions: Schema.Array(NextAction) },
) {}

/** The escalation is already ruled or withdrawn, or already raised. `nextActions` is never empty. */
export class EscalationStateRefused extends Schema.TaggedError<EscalationStateRefused>()(
  "EscalationStateRefused",
  {
    escalationId: EscalationId,
    state: Schema.optional(EscalationState),
    command: Schema.String,
    nextActions: Schema.Array(NextAction),
  },
) {}

/** An escalation that cannot be raised: fewer than two options, a repeated id, or a default that is not an option. */
export class InvalidEscalation extends Schema.TaggedError<InvalidEscalation>()(
  "InvalidEscalation",
  { escalationId: EscalationId, reason: Schema.String, nextActions: Schema.Array(NextAction) },
) {}

/** The move is not allowed for this conflict in its current state. */
export class MoveRefused extends Schema.TaggedError<MoveRefused>()("MoveRefused", {
  conflictId: ConflictId,
  reason: Schema.String,
}) {}

/** A verifier could not run the job: no capacity, the tier refused it, or the runner failed. */
export class VerifierUnavailable extends Schema.TaggedError<VerifierUnavailable>()(
  "VerifierUnavailable",
  {
    reason: Schema.String,
    retryAfterMs: Schema.optional(Schema.Int),
  },
) {}

/** A content-addressed object is missing from the bundle store. */
export class BundleMissing extends Schema.TaggedError<BundleMissing>()("BundleMissing", {
  hash: ContentHash,
}) {}

/** The flow spec at the base commit does not compile. */
export class FlowSpecInvalid extends Schema.TaggedError<FlowSpecInvalid>()("FlowSpecInvalid", {
  reason: Schema.String,
}) {}

/** A decision model or platform function gave no usable answer: timeout, rate limit, schema failure or truncation. Becomes `abstain`. */
export class ModelAbstained extends Schema.TaggedError<ModelAbstained>()("ModelAbstained", {
  reason: Schema.Literals(["timeout", "rate-limited", "schema", "truncated", "unavailable"]),
  /** Text of what was wrong, a repair's only input: the parser's message, the token limit, or an AI error's text. */
  detail: Schema.optional(Schema.String),
}) {}

// Flow compile errors: each typing rule is rejected with its own error.

/** The flow spec was not read from the change's base commit: a change cannot edit its own checks. */
export class SpecNotFromBase extends Schema.TaggedError<SpecNotFromBase>()("SpecNotFromBase", {
  specCommit: Schema.String,
  baseCommit: Schema.String,
}) {}
export class UnknownStep extends Schema.TaggedError<UnknownStep>()("UnknownStep", {
  step: Schema.String,
}) {}
export class StepUsedTwice extends Schema.TaggedError<StepUsedTwice>()("StepUsedTwice", {
  step: Schema.String,
}) {}
/** Every step can abstain. */
export class AbstainMissing extends Schema.TaggedError<AbstainMissing>()("AbstainMissing", {
  step: Schema.String,
}) {}
export class KindCeilingMismatch extends Schema.TaggedError<KindCeilingMismatch>()(
  "KindCeilingMismatch",
  {
    step: Schema.String,
    kind: Schema.String,
    ceiling: Schema.String,
  },
) {}
/** A step whose evidence is opinion or testimony may only escalate, annotate or abstain. */
export class OpinionMayOnlyRoute extends Schema.TaggedError<OpinionMayOnlyRoute>()(
  "OpinionMayOnlyRoute",
  {
    step: Schema.String,
    outcome: Schema.String,
  },
) {}
/** An opinion step may skip only steps the project marked optional. */
export class OpinionMaySkipOnlyOptional extends Schema.TaggedError<OpinionMaySkipOnlyOptional>()(
  "OpinionMaySkipOnlyOptional",
  {
    step: Schema.String,
    target: Schema.String,
  },
) {}
/** Only proof and rulings may fail. */
export class OnlyProofOrRulingMayFail extends Schema.TaggedError<OnlyProofOrRulingMayFail>()(
  "OnlyProofOrRulingMayFail",
  {
    step: Schema.String,
    effectiveClass: Schema.String,
  },
) {}
/** Only a human decision overrides a fail. */
export class OnlyHumanMayOverride extends Schema.TaggedError<OnlyHumanMayOverride>()(
  "OnlyHumanMayOverride",
  {
    step: Schema.String,
    kind: Schema.String,
  },
) {}
export class ReadsUnknown extends Schema.TaggedError<ReadsUnknown>()("ReadsUnknown", {
  step: Schema.String,
  read: Schema.String,
}) {}
export class ReadCycle extends Schema.TaggedError<ReadCycle>()("ReadCycle", {
  steps: Schema.Array(Schema.String),
}) {}
export class WhenRefersToNonPriorStep extends Schema.TaggedError<WhenRefersToNonPriorStep>()(
  "WhenRefersToNonPriorStep",
  {
    step: Schema.String,
  },
) {}
export class WhenOutcomeNotDeclared extends Schema.TaggedError<WhenOutcomeNotDeclared>()(
  "WhenOutcomeNotDeclared",
  {
    step: Schema.String,
    outcome: Schema.String,
  },
) {}
export class CascadeAcceptUnreachable extends Schema.TaggedError<CascadeAcceptUnreachable>()(
  "CascadeAcceptUnreachable",
  {
    accept: Schema.Array(Schema.String),
  },
) {}
export class WorldNotSupported extends Schema.TaggedError<WorldNotSupported>()(
  "WorldNotSupported",
  {
    step: Schema.String,
    world: Schema.String,
  },
) {}
export class InvalidBudget extends Schema.TaggedError<InvalidBudget>()("InvalidBudget", {
  where: Schema.String,
}) {}

export type CompileError =
  | SpecNotFromBase
  | UnknownStep
  | StepUsedTwice
  | AbstainMissing
  | KindCeilingMismatch
  | OpinionMayOnlyRoute
  | OpinionMaySkipOnlyOptional
  | OnlyProofOrRulingMayFail
  | OnlyHumanMayOverride
  | ReadsUnknown
  | ReadCycle
  | WhenRefersToNonPriorStep
  | WhenOutcomeNotDeclared
  | CascadeAcceptUnreachable
  | CascadeMayNotAcceptAbstain
  | WhenOnOpinionMayOnlyAddScrutiny
  | WorldNotSupported
  | InvalidBudget;

/**
 * A batch's member plans cannot run as one: they name the same step at
 * different versions (`stepId`), or were compiled by different compilers
 * (`stepId` absent). The Lane runs those members in separate batches.
 */
export class UnionVersionConflict extends Schema.TaggedError<UnionVersionConflict>()(
  "UnionVersionConflict",
  {
    stepId: Schema.optional(Schema.NonEmptyString),
    versions: Schema.Array(Schema.String),
  },
) {}

/** The verdict function was asked for a version it does not have. */
export class UnknownVerdictVersion extends Schema.TaggedError<UnknownVerdictVersion>()(
  "UnknownVerdictVersion",
  {
    version: Schema.String,
  },
) {}
/** A cascade's acceptance cannot be `abstain`: abstaining is the absence of an answer, and it escalates. */
export class CascadeMayNotAcceptAbstain extends Schema.TaggedError<CascadeMayNotAcceptAbstain>()(
  "CascadeMayNotAcceptAbstain",
  {},
) {}
/**
 * A `when` may consult an opinion only to add scrutiny: the condition must not
 * hold when the opinion merely annotates, and may not negate it. Otherwise a
 * quiet model would switch checks off.
 */
export class WhenOnOpinionMayOnlyAddScrutiny extends Schema.TaggedError<WhenOnOpinionMayOnlyAddScrutiny>()(
  "WhenOnOpinionMayOnlyAddScrutiny",
  { step: Schema.String },
) {}
