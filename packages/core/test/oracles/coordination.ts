/**
 * Independent oracles for the predicate lattices, written from the specified
 * rulings rather than from the implementation: each order is a table, and a
 * claim's region is decided point by point over a dense sample of values.
 */
import type {
  Authority,
  Bound,
  Cardinality,
  Claim,
  ClaimRelation,
  Consistency,
  Freshness,
  Tri,
} from "../../src/domain/coordination/index.ts";

type Label = "per-call" | "per-request" | "per-session" | "ttl" | "static";
const label = (v: Freshness): Label => (typeof v === "object" ? "ttl" : v);
const freshnessAbove: Record<Label, readonly Label[]> = {
  "per-call": ["per-call", "per-request", "per-session", "ttl", "static"],
  "per-request": ["per-request", "per-session", "ttl", "static"],
  "per-session": ["per-session", "static"],
  ttl: ["ttl", "static"],
  static: ["static"],
};

/** per-call < per-request < ttl(n) < static; per-request < per-session < static; per-session ∥ ttl(n). */
export const specFreshnessLeq = (a: Freshness, b: Freshness): Tri => {
  if (typeof a === "object" && typeof b === "object") return a.ttl <= b.ttl;
  const pair = [label(a), label(b)];
  if (pair.includes("per-session") && pair.includes("ttl")) return "unknown";
  return freshnessAbove[label(a)].includes(label(b));
};

const cardinalityAbove: Record<Cardinality, readonly Cardinality[]> = {
  "exactly-once": ["exactly-once", "at-most-once", "at-least-once", "any"],
  "at-most-once": ["at-most-once", "any"],
  "at-least-once": ["at-least-once", "any"],
  any: ["any"],
};
export const specCardinalityLeq = (a: Cardinality, b: Cardinality): boolean => cardinalityAbove[a].includes(b);

const consistencyTier = (v: Consistency): number =>
  typeof v === "object" ? 1 : { eventual: 0, "read-your-writes": 2, linearizable: 3 }[v];
/** eventual < bounded(t) < read-your-writes < linearizable; bounded(t) ≤ bounded(u) iff t ≥ u. */
export const specConsistencyLeq = (a: Consistency, b: Consistency): boolean =>
  typeof a === "object" && typeof b === "object" ? a.bounded >= b.bounded : consistencyTier(a) <= consistencyTier(b);

export const specAuthorityLeq = (a: Authority, b: Authority): boolean => a.writers.every((w) => b.writers.includes(w));

export const specBoundLeq = (a: Bound, b: Bound): boolean => a.n <= b.n;

/**
 * The same order in one possible world, where a session lasts `d` seconds:
 * per-session ≤ ttl(n) iff d ≤ n. The incomparable pair is the only unknown,
 * so fixing `d` makes the order total over the values that matter.
 */
const freshnessLeqIn = (d: number) => (a: Freshness, b: Freshness): boolean => {
  if (label(a) === "per-session" && typeof b === "object") return d <= b.ttl;
  if (typeof a === "object" && label(b) === "per-session") return a.ttl <= d;
  return specFreshnessLeq(a, b) === true;
};
const sessionWorlds = [-0.5, 0, 15, 30, 45, 60, 100, 180, 300, 450, 600, 1000];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const member = <V>(leq: (a: V, b: V) => Tri, x: V, relation: ClaimRelation, v: V): Tri => {
  if (relation === "at-most") return leq(x, v);
  if (relation === "at-least") return leq(v, x);
  const equal: Tri = same(x, v)
    ? true
    : leq(x, v) === "unknown" || leq(v, x) === "unknown"
      ? "unknown"
      : leq(x, v) === true && leq(v, x) === true;
  if (relation === "is") return equal;
  return equal === "unknown" ? "unknown" : !equal;
};

const freshnessSamples: readonly Freshness[] = [
  "per-call", "per-request", "per-session", "static",
  ...[0, 15, 30, 45, 60, 180, 300, 600].map((ttl): Freshness => ({ ttl })),
];
const consistencySamples: readonly Consistency[] = [
  "eventual", "read-your-writes", "linearizable",
  ...[0, 0.5, 1, 3, 5, 10].map((bounded): Consistency => ({ bounded })),
];
const cardinalitySamples: readonly Cardinality[] = ["exactly-once", "at-most-once", "at-least-once", "any"];
const authoritySamples: readonly Authority[] = (() => {
  const universe = ["a", "b", "c", "z"];
  return Array.from({ length: 16 }, (_, mask) => ({ writers: universe.filter((_w, i) => (mask >> i) % 2 === 1) }));
})();
const boundSamples = [-2, -1, -0.5, 0, 0.5, 1, 3, 5, 7.5, 10, 11];

type Membership = { readonly inEffect: Tri; readonly inPremise: Tri };

const over = <V>(
  samples: readonly V[],
  leq: (a: V, b: V) => Tri,
  p: { readonly relation: ClaimRelation; readonly value: V },
  e: { readonly relation: ClaimRelation; readonly value: V },
): readonly Membership[] =>
  samples.map((x) => ({ inEffect: member(leq, x, e.relation, e.value), inPremise: member(leq, x, p.relation, p.value) }));

/** Each sample's membership of the effect's and the premise's regions, or undefined if the oracle abstains. */
const memberships = (premise: Claim, effect: Claim): readonly Membership[] | undefined => {
  switch (premise.predicate) {
    case "freshness":
      return undefined;
    case "consistency":
      return effect.predicate === "consistency" ? over(consistencySamples, specConsistencyLeq, premise, effect) : undefined;
    case "cardinality":
      return effect.predicate === "cardinality" ? over(cardinalitySamples, specCardinalityLeq, premise, effect) : undefined;
    case "authority":
      return effect.predicate === "authority" ? over(authoritySamples, specAuthorityLeq, premise, effect) : undefined;
    case "bound":
      return effect.predicate === "bound" && effect.value.unit === premise.value.unit
        ? over(boundSamples.map((n): Bound => ({ n, unit: premise.value.unit })), specBoundLeq, premise, effect)
        : undefined;
    case "presence":
    case "purity":
    case "idempotent":
      return effect.predicate === premise.predicate
        ? over<boolean>([true, false], (a, b) => a === b, premise, effect)
        : undefined;
    default:
      return undefined;
  }
};

export type OracleDecision = "within" | "disjoint" | "overlap";

/**
 * within: every sample the effect might allow is certainly in the premise.
 * disjoint: no sample is possibly in both. Otherwise overlap.
 */
const decideMemberships = (ms: readonly Membership[]): OracleDecision => {
  if (ms.every((m) => m.inEffect === false || m.inPremise === true)) return "within";
  if (ms.every((m) => m.inEffect === false || m.inPremise === false)) return "disjoint";
  return "overlap";
};

const chains = new Set(["freshness", "consistency", "bound"]);
const ranged = (r: ClaimRelation): boolean => r === "at-most" || r === "at-least";

export const oracleDecision = (premise: Claim, effect: Claim): OracleDecision | undefined => {
  // The decidable fragment for `not` on a chain is a point on the other side;
  // `not` against a range always needs a probe.
  if (
    chains.has(premise.predicate) &&
    premise.predicate === effect.predicate &&
    ((premise.relation === "not" && ranged(effect.relation)) || (effect.relation === "not" && ranged(premise.relation)))
  ) {
    return "overlap";
  }
  if (premise.predicate === "freshness" && effect.predicate === "freshness") {
    // Decide in every possible world; a decision that changes between worlds is no decision.
    const perWorld = sessionWorlds.map((d) =>
      decideMemberships(
        freshnessSamples.map((x) => ({
          inEffect: member(freshnessLeqIn(d), x, effect.relation, effect.value),
          inPremise: member(freshnessLeqIn(d), x, premise.relation, premise.value),
        })),
      ),
    );
    const first = perWorld[0];
    return perWorld.every((w) => w === first) ? first : "overlap";
  }
  const ms = memberships(premise, effect);
  return ms === undefined ? undefined : decideMemberships(ms);
};
