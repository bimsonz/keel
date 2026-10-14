import { Schema } from "effect";
import { ChangeId, EvidenceClass } from "../kernel/index.ts";
import {
  FootprintEntry,
  MfpCitation,
  MfpEffectProposition,
  MfpPremiseProposition,
} from "../coordination/index.ts";

/**
 * MFP 0.2 messages as Keel states them, and Keel's record of each: the
 * protocol's JSON field for field, so a message leaves Keel as it is held.
 * Optional fields are left out, never undefined. A message carries what was
 * said and nothing Keel vouches for; who said it, when, for which change and
 * on what evidence is Keel's record around it. Every message names Keel's
 * profile, which closes a verdict's outcome and an observation's category.
 */

/** Keel's MFP profile, by the URI every message Keel states names. */
export const KEEL_MFP_PROFILE = "https://keel.town/mfp/profile/1";

/** Text a reader is meant to read: at least one non-space character. */
const Text = Schema.String.check(Schema.isPattern(/\S/));

const Citations = Schema.Array(MfpCitation);
/** Decisions and observations cite what they rest on. */
const NonEmptyCitations = Citations.check(Schema.isMinLength(1));

/** The members every message carries. */
const header = <K extends string>(kind: K) => ({
  mfp: Schema.Literal("0.2"),
  kind: Schema.Literal(kind),
  profile: Schema.Literal(KEEL_MFP_PROFILE),
});

/** The model's own confidence in a message. It never carries weight. */
const confidence = Schema.optionalKey(Schema.Literals(["low", "medium", "high"]));

/** A footprint entry as 0.2 states it: Keel's, with no symbol left out rather than undefined. */
const MfpFootprintEntry = Schema.Struct({
  ...FootprintEntry.fields,
  symbol: Schema.optionalKey(Schema.String),
});

/** What a change will achieve and what it relies on, before code is written. */
export const MfpIntent = Schema.Struct({
  ...header("intent"),
  goal: Text,
  footprint: Schema.optionalKey(Schema.Array(MfpFootprintEntry)),
  premises: Schema.Array(MfpPremiseProposition),
  declaredEffects: Schema.optionalKey(Schema.Array(MfpEffectProposition)),
  cites: Schema.optionalKey(Citations),
  confidence,
});
export type MfpIntent = typeof MfpIntent.Type;

/** One more thing relied on, after the intent. */
export const MfpPremise = Schema.Struct({
  ...header("premise"),
  premise: MfpPremiseProposition,
  cites: Schema.optionalKey(Citations),
  confidence,
});
export type MfpPremise = typeof MfpPremise.Type;

/** A choice made, why, and what it rejected. */
export const MfpDecision = Schema.Struct({
  ...header("decision"),
  question: Schema.optionalKey(Schema.String),
  chosen: Text,
  rationale: Text,
  alternatives: Schema.Array(Schema.Struct({ option: Text, reasonRejected: Text })),
  reversible: Schema.Boolean,
  cites: NonEmptyCitations,
  confidence,
});
export type MfpDecision = typeof MfpDecision.Type;

/** Something noticed, and what it rests on. Keel's profile closes the category to `guard`. */
export const MfpObservation = Schema.Struct({
  ...header("observation"),
  category: Schema.Literal("guard"),
  importance: Schema.Literals(["low", "medium", "high"]),
  summary: Text,
  cites: NonEmptyCitations,
  confidence,
});
export type MfpObservation = typeof MfpObservation.Type;

/** How work relates to an earlier decision met as precedent, named by the ref Keel gave it. */
export const MfpStance = Schema.Struct({
  ...header("stance"),
  decision: Schema.NonEmptyString,
  stance: Schema.Literals(["followed", "distinguished", "overrule-requested"]),
  argument: Text,
  cites: Schema.optionalKey(Citations),
  confidence,
});
export type MfpStance = typeof MfpStance.Type;

/** The outcome work should have, as an opinion. Keel's profile closes the outcome to Keel's five. */
export const MfpVerdict = Schema.Struct({
  ...header("verdict"),
  outcome: Schema.Literals(["land", "bounce", "park", "hold", "supersede"]),
  reasons: Schema.Array(
    Schema.Struct({ summary: Text, cites: Schema.optionalKey(Citations) }),
  ).check(Schema.isMinLength(1)),
  residualRisk: Schema.optionalKey(Schema.String),
  cites: Schema.optionalKey(Citations),
  confidence,
});
export type MfpVerdict = typeof MfpVerdict.Type;

/** A message Keel states. */
export const MfpMessage = Schema.Union([
  MfpIntent,
  MfpPremise,
  MfpDecision,
  MfpObservation,
  MfpStance,
  MfpVerdict,
]);
export type MfpMessage = typeof MfpMessage.Type;

/** Who stated a message. A platform-derived record never reads as something an agent said. */
export const RecordAuthor = Schema.Struct({
  kind: Schema.Literals(["human", "agent", "platform"]),
  id: Schema.String,
});
export type RecordAuthor = typeof RecordAuthor.Type;

/** An instant as a date-time: RFC 3339 in UTC or with an offset, as `Date.toISOString` gives it. */
const DateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/),
);

/**
 * Keel's record of an MFP message: who stated it, when, for which change, the
 * class of evidence it rests on and where it holds, which MFP 0.2 leaves to
 * the receiver.
 */
export const KeelRecord = Schema.Struct({
  id: Schema.String,
  author: RecordAuthor,
  at: DateTime,
  change: Schema.optionalKey(ChangeId),
  evidenceClass: Schema.optionalKey(EvidenceClass),
  scope: Schema.optionalKey(Schema.String),
  message: MfpMessage,
});
export type KeelRecord = typeof KeelRecord.Type;
