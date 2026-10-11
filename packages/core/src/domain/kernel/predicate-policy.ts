import { Schema } from "effect";

/**
 * A predicate policy: what a proven conflict on a predicate does, as the
 * project composed it for the change (ADR 0005, decided 11 Oct). `block`
 * holds the challenger for a ruling, `advise` warns both agents and offers the
 * proving test, `annotate` only records it. A tenet never blocks by itself:
 * its guard's failure takes this policy wherever it becomes a verdict.
 */
export const PredicatePolicy = Schema.Literals(["block", "advise", "annotate"]);
export type PredicatePolicy = typeof PredicatePolicy.Type;

/** The policy when the project names none. */
export const DEFAULT_PREDICATE_POLICY: PredicatePolicy = "advise";
