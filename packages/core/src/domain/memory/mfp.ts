import { Schema } from "effect";
import { EvidenceClass } from "../kernel/index.ts";
import { Predicate, Relation, Strength } from "../coordination/index.ts";

/**
 * MFP 0.1 records as Keel states them: the protocol's JSON field for field, so
 * a record leaves Keel as it is held. Optional fields are left out, never
 * undefined, and instants are RFC 3339 strings. Only the kinds Keel states
 * are here: an intent, a premise, a decision, an observation and a verdict.
 */

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

/** An instant as MFP writes it: RFC 3339 in UTC or with an offset, as `Date.toISOString` gives it. */
export const MfpInstant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/),
);

/** Who made the claim. A platform-derived record never reads as something an agent said. */
export const MfpAuthor = Schema.Struct({
  kind: Schema.Literals(["agent", "platform", "human"]),
  id: NonEmpty,
});
export type MfpAuthor = typeof MfpAuthor.Type;

export const MfpAnchor = Schema.Struct({
  path: NonEmpty,
  symbol: Schema.optionalKey(Schema.String),
  commit: Schema.String.check(Schema.isMinLength(4)),
});
export type MfpAnchor = typeof MfpAnchor.Type;

/** A numbered session message, a code anchor, or another MFP record by id. */
export const MfpCitation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    session: Schema.String,
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ kind: Schema.Literal("anchor"), anchor: MfpAnchor }),
  Schema.Struct({ kind: Schema.Literal("record"), id: Schema.String }),
]);
export type MfpCitation = typeof MfpCitation.Type;

export const MfpEvidence = Schema.Struct({
  class: EvidenceClass,
  source: Schema.optionalKey(
    Schema.Literals(["source", "tool-result", "prior-record", "external", "reasoning"]),
  ),
  ref: NonEmpty,
  at: MfpInstant,
  scope: Schema.optionalKey(Schema.String),
});
export type MfpEvidence = typeof MfpEvidence.Type;

/** A typed statement about a subject; `strength` is always written, `must` where the holder gave none. */
export const MfpProposition = Schema.Struct({
  subject: NonEmpty,
  predicate: Predicate,
  relation: Relation,
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  unit: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  anchors: Schema.optionalKey(Schema.Array(MfpAnchor)),
  gloss: Schema.optionalKey(Schema.String),
  strength: Strength,
  cites: Schema.optionalKey(Schema.Array(MfpCitation)),
});
export type MfpProposition = typeof MfpProposition.Type;

export const MfpIntent = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  goal: NonEmpty,
  footprint: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: NonEmpty,
        symbol: Schema.optionalKey(Schema.String),
        op: Schema.Literals(["edit", "create", "delete"]),
      }),
    ),
  ),
  premises: Schema.Array(MfpProposition),
  declaredEffects: Schema.optionalKey(Schema.Array(MfpProposition)),
});

export const MfpDecision = Schema.Struct({
  question: Schema.optionalKey(Schema.String),
  chosen: NonEmpty,
  rationale: NonEmpty,
  alternatives: Schema.Array(Schema.Struct({ option: NonEmpty, reasonRejected: NonEmpty })),
  reversible: Schema.Boolean,
});

export const MfpObservation = Schema.Struct({
  category: NonEmpty,
  importance: Schema.Literals(["low", "medium", "high"]),
  summary: NonEmpty,
  evidence: Schema.Array(MfpEvidence),
});

export const MfpVerdict = Schema.Struct({
  outcome: Schema.Literals(["land", "bounce", "park", "hold", "supersede"]),
  reasons: Schema.Array(MfpEvidence).check(Schema.isMinLength(1)),
  residualRisk: Schema.optionalKey(Schema.String),
  cost: Schema.optionalKey(
    Schema.Struct({
      ms: Schema.optionalKey(Schema.Int),
      tokens: Schema.optionalKey(Schema.Int),
      usd: Schema.optionalKey(Schema.Finite),
    }),
  ),
});

const Citations = Schema.Array(MfpCitation);
/** Decisions and verdicts cite what they rest on. */
const NonEmptyCitations = Citations.check(Schema.isMinLength(1));

/** The fields every record carries but its kind, its citations and its payload. */
const ENVELOPE = {
  mfp: Schema.Literal("0.1"),
  id: NonEmpty,
  /** The change the claim is about. */
  change: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(Schema.String),
  author: MfpAuthor,
  actor: Schema.optionalKey(
    Schema.Struct({
      harness: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String),
    }),
  ),
  at: MfpInstant,
  base: Schema.optionalKey(Schema.String),
  seq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  evidenceClass: Schema.optionalKey(EvidenceClass),
  scope: Schema.optionalKey(Schema.String),
  supersedes: Schema.optionalKey(Schema.String),
  privacy: Schema.optionalKey(
    Schema.Struct({
      class: Schema.Literals(["public", "internal", "restricted"]),
      redactions: Schema.optionalKey(
        Schema.Array(Schema.Struct({ pointer: Schema.String, reason: Schema.String })),
      ),
    }),
  ),
  countersig: Schema.optionalKey(Schema.String),
};

export const MfpIntentRecord = Schema.Struct({
  ...ENVELOPE,
  kind: Schema.Literal("intent"),
  cites: Citations,
  payload: MfpIntent,
});
export const MfpPremiseRecord = Schema.Struct({
  ...ENVELOPE,
  kind: Schema.Literal("premise"),
  cites: Citations,
  payload: Schema.Struct({ proposition: MfpProposition }),
});
export const MfpDecisionRecord = Schema.Struct({
  ...ENVELOPE,
  kind: Schema.Literal("decision"),
  cites: NonEmptyCitations,
  payload: MfpDecision,
});
export const MfpObservationRecord = Schema.Struct({
  ...ENVELOPE,
  kind: Schema.Literal("observation"),
  cites: Citations,
  payload: MfpObservation,
});
export const MfpVerdictRecord = Schema.Struct({
  ...ENVELOPE,
  kind: Schema.Literal("verdict"),
  cites: NonEmptyCitations,
  payload: MfpVerdict,
});

/** A record Keel states. */
export const MfpRecord = Schema.Union([
  MfpIntentRecord,
  MfpPremiseRecord,
  MfpDecisionRecord,
  MfpObservationRecord,
  MfpVerdictRecord,
]);
export type MfpRecord = typeof MfpRecord.Type;
