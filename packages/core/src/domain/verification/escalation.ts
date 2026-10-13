import { Schema } from "effect";
import {
  DecisionId,
  EntityRef,
  EscalationId,
  EvidenceClass,
  InstantSchema,
} from "../kernel/index.ts";
import { EscalationState } from "../memory/index.ts";

/** Why a question needs a person: the kinds Mission Control's ruling inbox sorts by. */
export const EscalationCategory = Schema.Literals([
  "permission-semantics",
  "destructive-migration",
  "ambiguous-requirement",
  "unprovable-conflict",
  "overrule-request",
  "frozen-trunk",
]);
export type EscalationCategory = typeof EscalationCategory.Type;

/** One answer a person can give, with what choosing it does. A ruling names it by `id`. */
export const EscalationOption = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.String,
  consequence: Schema.String,
});
export type EscalationOption = typeof EscalationOption.Type;

/** One piece of evidence put before the person, by class, so Mission Control can group it. */
export const EscalationEvidence = Schema.Struct({
  class: EvidenceClass,
  summary: Schema.NonEmptyString,
  ref: Schema.optional(Schema.String),
});
export type EscalationEvidence = typeof EscalationEvidence.Type;

/** A person's answer: the option chosen, by whom, and why. */
export const Ruling = Schema.Struct({
  option: Schema.NonEmptyString,
  by: Schema.String,
  rationale: Schema.optional(Schema.String),
});
export type Ruling = typeof Ruling.Type;

/**
 * A question routed to a person, with options and their consequences. While
 * open, its owner holds; the default is only a suggestion and is never applied
 * on a timeout. Answering it produces a Decision.
 */
export const Escalation = Schema.Struct({
  id: EscalationId,
  state: EscalationState,
  question: Schema.NonEmptyString,
  options: Schema.Array(EscalationOption),
  about: EntityRef,
  category: EscalationCategory,
  evidence: Schema.Array(EscalationEvidence),
  precedents: Schema.Array(DecisionId),
  /** The option suggested to the person: always one of `options`. */
  default: Schema.NonEmptyString,
  raisedAt: InstantSchema,
  /** When its namespace's maintainers were asked too; absent while only the person asked first has been. */
  widenedAt: Schema.optional(InstantSchema),
  ruling: Schema.optional(Ruling),
  withdrawnReason: Schema.optional(Schema.String),
});
export type Escalation = typeof Escalation.Type;
