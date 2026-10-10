import { Schema } from "effect";
import { Anchor, EvidenceClass } from "../kernel/index.ts";
import { Proposition } from "./proposition.ts";

/** How an effect was found. An extractor's finding is proof; a model's is opinion. */
export const DerivationMethod = Schema.Literals(["extractor", "clef", "code-model"]);
export type DerivationMethod = typeof DerivationMethod.Type;

/** What a change alters, as Keel derived it from the diff. Never taken from the agent. */
export const DerivedEffect = Schema.Struct({
  proposition: Proposition,
  method: DerivationMethod,
  evidenceClass: EvidenceClass,
  /** The model's probability, when a model answered. */
  p: Schema.optional(Schema.Number),
  anchors: Schema.Array(Anchor),
  declared: Schema.Boolean,
  /** A premise or tenet this effect contradicts, by reference. */
  contradicts: Schema.optional(Schema.String),
});
export type DerivedEffect = typeof DerivedEffect.Type;

export const DriftClass = Schema.Literals(["footprint", "undeclared-effect", "silent-retraction"]);
export type DriftClass = typeof DriftClass.Type;

export const Drift = Schema.Struct({
  class: DriftClass,
  severity: Schema.Literals(["low", "medium", "high"]),
  detail: Schema.String,
});
export type Drift = typeof Drift.Type;
