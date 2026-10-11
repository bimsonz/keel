import { Schema } from "effect";
import type { Predicate } from "../coordination/index.ts";

/**
 * One relabelled ask of a decision model, reduced by the adapter to two
 * masses: on values that violate the premise, and on the other lattice
 * values, `unclear` excluded. The rest of the mass is `unclear`.
 */
export const OpinionAsk = Schema.Struct({
  violating: Schema.Finite,
  compatible: Schema.Finite,
});
export type OpinionAsk = typeof OpinionAsk.Type;

/**
 * One predicate's thresholds. An ask votes contradiction at `raise`, and
 * compatible at `floor` on the compatible side; `quorum` is how many of the
 * three asks must vote alike.
 */
export const GateThreshold = Schema.Struct({
  quorum: Schema.Literals(["all", "two-of-three"]),
  raise: Schema.Finite,
  floor: Schema.Finite,
});
export type GateThreshold = typeof GateThreshold.Type;

/** Per-project thresholds in `.keel/flow`: one per predicate, and `global` for the rest. */
export type GateTable = {
  readonly global: GateThreshold;
  readonly predicates: Readonly<Partial<Record<Predicate, GateThreshold>>>;
};

/**
 * What an opinion may do (ADR 0005): open a suspected conflict for a probe
 * to decide, annotate, or escalate to a person. Never block, never clear.
 */
export type GateOutcome = "suspect" | "annotate" | "escalate";

/** The three relabelled asks every question is put as, in one call. */
export const ASKS = 3;

/** Floating sums of probabilities drift a little past 1. */
const MASS_SLACK = 1e-6;

const unit = (x: number): boolean => Number.isFinite(x) && x >= 0 && x <= 1;

const validAsk = (ask: OpinionAsk | undefined): ask is OpinionAsk =>
  ask !== undefined &&
  unit(ask.violating) &&
  unit(ask.compatible) &&
  ask.violating + ask.compatible <= 1 + MASS_SLACK;

type Vote = "contradiction" | "compatible" | "abstain";

/** An ask meeting both thresholds votes contradiction: the conservative side, since the probe then decides. */
const voteOf = (ask: OpinionAsk, t: GateThreshold): Vote =>
  ask.violating >= t.raise ? "contradiction" : ask.compatible >= t.floor ? "compatible" : "abstain";

const quorumOf = (t: GateThreshold): number => (t.quorum === "all" ? ASKS : 2);

/**
 * Routes a decision model's answer to one premise question (ADR 0012). A quorum of contradiction votes suspects, a quorum of compatible
 * votes annotates, and anything else escalates: a split, abstentions, the
 * middle band, a missing or malformed ask, or a threshold outside [0, 1]. A
 * truncated step passes every ask as missing.
 */
export const gateOpinion = (
  asks: readonly (OpinionAsk | undefined)[],
  threshold: GateThreshold,
): GateOutcome => {
  if (!unit(threshold.raise) || !unit(threshold.floor)) return "escalate";
  if (asks.length !== ASKS || !asks.every(validAsk)) return "escalate";
  const votes = asks.map((ask) => voteOf(ask, threshold));
  const quorum = quorumOf(threshold);
  if (votes.filter((v) => v === "contradiction").length >= quorum) return "suspect";
  if (votes.filter((v) => v === "compatible").length >= quorum) return "annotate";
  return "escalate";
};

const all = (raise: number): GateThreshold => ({ quorum: "all", raise, floor: raise });
const twoOfThree = (raise: number): GateThreshold => ({
  quorum: "two-of-three",
  raise,
  floor: raise,
});

/**
 * The defaults spike S17c measured (fitted in-sample, not yet confirmed on a
 * held-out set). `floor` equals `raise` everywhere: the symmetric rule S17c
 * measured, with no silent miss at any threshold. `idempotent` takes purity's
 * row, as S17c asked it; `invariant` and anything unlisted take `global`.
 */
export const DEFAULT_GATE: GateTable = {
  global: twoOfThree(0.85),
  predicates: {
    shape: all(0.5),
    presence: all(0.5),
    authority: all(0.5),
    bound: all(0.5),
    purity: twoOfThree(0.5),
    idempotent: twoOfThree(0.5),
    cardinality: twoOfThree(0.5),
    freshness: all(0.65),
    ordering: twoOfThree(0.7),
    consistency: all(0.75),
  },
};

/** A predicate's thresholds in a table, or the table's global row. */
export const gateFor = (predicate: Predicate, table: GateTable = DEFAULT_GATE): GateThreshold =>
  table.predicates[predicate] ?? table.global;
