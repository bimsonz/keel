import { Schema } from "effect";
import { Anchor } from "../kernel/index.ts";
import { Proposition } from "./proposition.ts";

/** How an effect was found. An extractor's finding is a ruling; a model's is opinion. */
export const DerivationMethod = Schema.Literals(["extractor", "clef", "code-model"]);
export type DerivationMethod = typeof DerivationMethod.Type;

/** A model's probability for its answer. */
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const derivedFields = {
  proposition: Proposition,
  /** Code locations the derivation rests on: at least one. */
  anchors: Schema.Array(Anchor).check(Schema.isMinLength(1)),
  /** Whether the change's agent had declared this effect. */
  declared: Schema.Boolean,
  /** A premise or tenet this effect contradicts, by reference. */
  contradicts: Schema.optional(Schema.String),
};

/**
 * Found by a deterministic extractor: a ruling, a deterministic judgement over
 * the diff, with no probability. Never proof: an extractor executes nothing,
 * and proof comes only from execution (probes, suites, guards).
 */
export const ExtractedEffect = Schema.Struct({
  ...derivedFields,
  method: Schema.Literal("extractor"),
  evidenceClass: Schema.Literal("ruling"),
});
/** Answered by a decision model: opinion, always with its probability. */
export const DecisionModelEffect = Schema.Struct({
  ...derivedFields,
  method: Schema.Literal("clef"),
  evidenceClass: Schema.Literal("opinion"),
  p: Probability,
});
/** Proposed by a code model: opinion, with a probability when the model gave one. */
export const CodeModelEffect = Schema.Struct({
  ...derivedFields,
  method: Schema.Literal("code-model"),
  evidenceClass: Schema.Literal("opinion"),
  p: Schema.optional(Probability),
});

/**
 * What a change alters, as Keel derived it from the diff: a platform
 * derivation, never taken from the agent. The method fixes the evidence
 * class, which the platform assigns.
 */
export const DerivedEffect = Schema.Union([ExtractedEffect, DecisionModelEffect, CodeModelEffect]);
export type DerivedEffect = typeof DerivedEffect.Type;

export const DriftClass = Schema.Literals(["footprint", "undeclared-effect", "silent-retraction"]);
export type DriftClass = typeof DriftClass.Type;

export const Drift = Schema.Struct({
  class: DriftClass,
  severity: Schema.Literals(["low", "medium", "high"]),
  detail: Schema.String,
});
export type Drift = typeof Drift.Type;
