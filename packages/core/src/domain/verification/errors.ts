import { Schema } from "effect";
import { ConflictId, ContentHash, EscalationId, VerdictId } from "../kernel/index.ts";

export class ConflictNotFound extends Schema.TaggedError<ConflictNotFound>()("ConflictNotFound", { conflictId: ConflictId }) {}

export class VerdictNotFound extends Schema.TaggedError<VerdictNotFound>()("VerdictNotFound", { verdictId: VerdictId }) {}

export class EscalationNotFound extends Schema.TaggedError<EscalationNotFound>()("EscalationNotFound", { escalationId: EscalationId }) {}

/** The move is not allowed for this conflict in its current state. */
export class MoveRefused extends Schema.TaggedError<MoveRefused>()("MoveRefused", { conflictId: ConflictId, reason: Schema.String }) {}

/** A verifier could not run the job: no capacity, the tier refused it, or the runner failed. */
export class VerifierUnavailable extends Schema.TaggedError<VerifierUnavailable>()("VerifierUnavailable", {
  reason: Schema.String,
  retryAfterMs: Schema.optional(Schema.Int),
}) {}

/** A content-addressed object is missing from the bundle store. */
export class BundleMissing extends Schema.TaggedError<BundleMissing>()("BundleMissing", { hash: ContentHash }) {}

/** The flow spec at the base commit does not compile. */
export class FlowSpecInvalid extends Schema.TaggedError<FlowSpecInvalid>()("FlowSpecInvalid", { reason: Schema.String }) {}

/** A decision model or platform function gave no usable answer: timeout, rate limit, schema failure or truncation. Becomes `abstain`. */
export class ModelAbstained extends Schema.TaggedError<ModelAbstained>()("ModelAbstained", {
  reason: Schema.Literals(["timeout", "rate-limited", "schema", "truncated", "unavailable"]),
}) {}
