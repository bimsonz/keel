import { Result } from "effect";
import { type Claim, type ReadProposition, readClaim } from "./claim.ts";
import {
  authorityDecision,
  boundDecision,
  booleans,
  cardinalities,
  cardinalityLeq,
  consistencyDecision,
  discreteLeq,
  finiteOrderDecision,
  freshnessDecision,
  orderingDecision,
  type RegionDecision,
} from "./lattice.ts";
import type { Proposition } from "./proposition.ts";
import { scopeCovers, scopesIntersect } from "./scope.ts";
import { shapeDecision } from "./shape.ts";
import { isAncestorOrSelf, subjectsRelated } from "./subject.ts";

/**
 * - compatible  the effect satisfies the premise across the premise's whole domain
 * - refines     it satisfies it, but speaks for only part of that domain
 *               (a narrower subject or scope)
 * - contradicts no behaviour the effect allows satisfies the premise
 * - needs-probe the lattice cannot settle it; only a probe can
 * - unrelated   different subjects, scopes or predicates
 */
export type ComparisonOutcome =
  | "compatible"
  | "refines"
  | "contradicts"
  | "needs-probe"
  | "unrelated";

export type ComparisonReason =
  | "subjects-unrelated"
  | "scopes-disjoint"
  | "unreadable"
  | "invariant-is-model-compared"
  | "predicates-differ"
  | "lattice";

export type Comparison = { readonly outcome: ComparisonOutcome; readonly reason: ComparisonReason };

/** How the effect's region sits against the premise's, for one predicate. */
const decideClaims = (p: Claim, e: Claim): RegionDecision => {
  switch (p.predicate) {
    case "freshness":
      return e.predicate === p.predicate ? freshnessDecision(p, e) : "unrelated";
    case "consistency":
      return e.predicate === p.predicate ? consistencyDecision(p, e) : "unrelated";
    case "bound":
      return e.predicate === p.predicate ? boundDecision(p, e) : "unrelated";
    case "cardinality":
      return e.predicate === p.predicate
        ? finiteOrderDecision(cardinalities, cardinalityLeq, p, e)
        : "unrelated";
    case "presence":
    case "purity":
    case "idempotent":
      return e.predicate === p.predicate
        ? finiteOrderDecision(booleans, discreteLeq, p, e)
        : "unrelated";
    case "authority":
      return e.predicate === p.predicate ? authorityDecision(p, e) : "unrelated";
    case "shape":
      return e.predicate === p.predicate ? shapeDecision(p, e) : "unrelated";
    case "ordering":
      return e.predicate === p.predicate ? orderingDecision(p.value, e.value) : "unrelated";
    default:
      // invariant: free-form text, compared only by a model
      return "overlap";
  }
};

/** The effect speaks for everything the premise relies on: its subject and its scope. */
const covers = (premise: ReadProposition, effect: ReadProposition): boolean =>
  isAncestorOrSelf(effect.subject, premise.subject) && scopeCovers(effect.scope, premise.scope);

/** Compares two propositions already read onto their lattices. */
export const compareRead = (premise: ReadProposition, effect: ReadProposition): Comparison => {
  if (!subjectsRelated(premise.subject, effect.subject))
    return { outcome: "unrelated", reason: "subjects-unrelated" };
  if (!scopesIntersect(premise.scope, effect.scope))
    return { outcome: "unrelated", reason: "scopes-disjoint" };
  if (premise.claim.predicate === "invariant" || effect.claim.predicate === "invariant") {
    return { outcome: "needs-probe", reason: "invariant-is-model-compared" };
  }
  if (premise.claim.predicate !== effect.claim.predicate)
    return { outcome: "unrelated", reason: "predicates-differ" };
  const decision = decideClaims(premise.claim, effect.claim);
  if (decision === "within")
    return { outcome: covers(premise, effect) ? "compatible" : "refines", reason: "lattice" };
  if (decision === "disjoint") return { outcome: "contradicts", reason: "lattice" };
  if (decision === "overlap") return { outcome: "needs-probe", reason: "lattice" };
  return { outcome: "unrelated", reason: "lattice" };
};

/**
 * Compares what a premise relies on with what an effect alters. A proposition
 * that does not read on its lattice can neither contradict nor clear: on a
 * related subject it needs a probe.
 */
export const compare = (premise: Proposition, effect: Proposition): Comparison => {
  if (!subjectsRelated(premise.subject, effect.subject))
    return { outcome: "unrelated", reason: "subjects-unrelated" };
  const p = readClaim(premise);
  const e = readClaim(effect);
  if (Result.isFailure(p) || Result.isFailure(e))
    return { outcome: "needs-probe", reason: "unreadable" };
  return compareRead(p.success, e.success);
};
