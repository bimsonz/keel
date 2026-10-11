/**
 * Predicate value domains and how two claims on one predicate relate.
 *
 * A claim denotes a region of values: `at-most v` is everything at or below
 * v, `at-least v` everything at or above it, `is v` just v, and `not v`
 * everything else. An effect's
 * region is a sound over-approximation of what the code can now do, and a
 * premise's region is what its holder relies on. Comparing the two gives a
 * Decision:
 *
 *   within    E ⊆ P: every behaviour the effect allows satisfies the premise
 *   disjoint  E ∩ P = ∅: no behaviour the effect allows satisfies it
 *   overlap   neither can be shown, so only a probe can settle it
 *   unrelated the two claims are about different things (ordering pairs)
 */

/** The relations a lattice claim can take; `before`/`after` belong to ordering alone. */
export type ClaimRelation = "at-most" | "at-least" | "is" | "not";
export type RegionDecision = "within" | "disjoint" | "overlap" | "unrelated";
/** A three-valued answer: some pairs are genuinely undecidable from the lattice. */
export type Tri = boolean | "unknown";

// ---------------------------------------------------------------- freshness

/**
 * Staleness, as a partial order: per-call < per-request < ttl(n) < static,
 * ttl(n) ≤ ttl(m) iff n ≤ m, and per-request < per-session < static. A
 * session can outlive or underlive any TTL, so per-session and ttl(n) are
 * incomparable and any comparison between them needs a probe.
 */
export type Freshness =
  | "per-call"
  | "per-request"
  | "per-session"
  | "static"
  | { readonly ttl: number };

/**
 * The effect form "cached, invalidated on E": a cache that serves `cached`
 * staleness, except that each event in `invalidatedOn` evicts it in that
 * event's own handler, against the same store. A change that arrives by one
 * of those events is stale at most meet(cached, per-request); any other
 * change, at most `cached`. Only effects take this form: a premise states
 * the freshness it relies on.
 */
export type Invalidated = {
  readonly cached: Freshness;
  /** Dotted event keys, sorted, deduped and never empty. */
  readonly invalidatedOn: readonly string[];
};
export type FreshnessValue = Freshness | Invalidated;

export const isInvalidated = (v: FreshnessValue): v is Invalidated =>
  typeof v === "object" && "cached" in v;

const isTtl = (v: Freshness): v is { readonly ttl: number } => typeof v === "object";

/** meet(v, per-request): per-request sits below everything except per-call. */
export const meetPerRequest = (v: Freshness): Freshness =>
  v === "per-call" ? "per-call" : "per-request";

const freshnessRank = (v: "per-call" | "per-request" | "per-session" | "static"): number =>
  ({ "per-call": 0, "per-request": 1, "per-session": 2, static: 3 })[v];

export const freshnessLeq = (a: Freshness, b: Freshness): Tri => {
  if (isTtl(a) && isTtl(b)) return a.ttl <= b.ttl;
  if (isTtl(a)) return b === "static" ? true : b === "per-session" ? "unknown" : false;
  if (isTtl(b))
    return a === "per-call" || a === "per-request" ? true : a === "per-session" ? "unknown" : false;
  return freshnessRank(a) <= freshnessRank(b);
};

type Interval = { readonly lo: number; readonly hi: number };

const intervalDecision = (p: Interval, e: Interval): RegionDecision => {
  if (p.lo <= e.lo && e.hi <= p.hi) return "within";
  if (e.hi < p.lo || p.hi < e.lo) return "disjoint";
  return "overlap";
};

/**
 * `not` on a chain is decided only against a point: `not v` against `is x`
 * holds when x ≠ v; anything wider needs a probe. (Exact complements of ranges
 * would need open intervals, and erring towards a probe is the safe side.)
 */
const notDecision = <V>(
  p: { readonly relation: ClaimRelation; readonly value: V },
  e: { readonly relation: ClaimRelation; readonly value: V },
): RegionDecision => {
  const same = JSON.stringify(p.value) === JSON.stringify(e.value);
  if (p.relation === "not" && e.relation === "is") return same ? "disjoint" : "within";
  if (p.relation === "is" && e.relation === "not") return same ? "disjoint" : "overlap";
  if (p.relation === "not" && e.relation === "not") return same ? "within" : "overlap";
  return "overlap";
};

const involvesNot = (
  p: { readonly relation: ClaimRelation },
  e: { readonly relation: ClaimRelation },
): boolean => p.relation === "not" || e.relation === "not";

const interval = (
  relation: ClaimRelation,
  position: number,
  bottom: number,
  top: number,
): Interval =>
  relation === "at-most"
    ? { lo: bottom, hi: position }
    : relation === "at-least"
      ? { lo: position, hi: top }
      : { lo: position, hi: position };

/**
 * Every freshness value is a position on the staleness line, except
 * per-session, whose position `d` (somewhere above per-request, below static)
 * is unknown. Decide under every ordering of `d` against the TTLs involved; a
 * decision that depends on `d` is not a decision.
 */
const freshnessPosition = (v: Freshness, session: number): number =>
  isTtl(v)
    ? v.ttl
    : v === "per-call"
      ? -2
      : v === "per-request"
        ? -1
        : v === "per-session"
          ? session
          : Number.POSITIVE_INFINITY;

const sessionCandidates = (ttls: readonly number[]): readonly number[] => {
  const sorted = [...new Set(ttls)].toSorted((a, b) => a - b);
  const last = sorted.at(-1);
  if (last === undefined) return [0];
  const between = sorted.slice(1).map((n, i) => ((sorted[i] ?? n) + n) / 2);
  return [-0.5, ...sorted, ...between, last + 1];
};

const validTtl = (v: Freshness): boolean => !isTtl(v) || (Number.isFinite(v.ttl) && v.ttl >= 0);

const plainFreshnessDecision = (
  p: { readonly relation: ClaimRelation; readonly value: Freshness },
  e: { readonly relation: ClaimRelation; readonly value: Freshness },
): RegionDecision => {
  if (!validTtl(p.value) || !validTtl(e.value)) return "overlap";
  if (involvesNot(p, e)) {
    const sessionAgainstTtl =
      (p.value === "per-session" && isTtl(e.value)) ||
      (isTtl(p.value) && e.value === "per-session");
    return sessionAgainstTtl ? "overlap" : notDecision(p, e);
  }
  const ttls = [p.value, e.value].flatMap((v) => (isTtl(v) ? [v.ttl] : []));
  const decisions = sessionCandidates(ttls).map((d) =>
    intervalDecision(
      interval(p.relation, freshnessPosition(p.value, d), -2, Number.POSITIVE_INFINITY),
      interval(e.relation, freshnessPosition(e.value, d), -2, Number.POSITIVE_INFINITY),
    ),
  );
  const first = decisions[0] ?? "overlap";
  return decisions.every((d) => d === first) ? first : "overlap";
};

/** Several kinds of change at once: the premise holds only if it holds for every one. */
const everyChange = (a: RegionDecision, b: RegionDecision): RegionDecision =>
  a === "disjoint" || b === "disjoint"
    ? "disjoint"
    : a === "within" && b === "within"
      ? "within"
      : "overlap";

/**
 * Which events change the subject is unknown, beyond those the effect evicts
 * on (the extractor saw each one's handler evict). So decide both cases:
 * every change arrives by an evicting event, or some change does not. Answer
 * only when the two agree; otherwise only a probe can settle it.
 */
const invalidationDecision = (
  p: { readonly relation: ClaimRelation; readonly value: Freshness },
  relation: ClaimRelation,
  e: Invalidated,
): RegionDecision => {
  if (e.invalidatedOn.length === 0 || (relation !== "is" && relation !== "at-most"))
    return "overlap";
  // A change through an evicting event: the effect's own region, each value met with per-request.
  const evicted = plainFreshnessDecision(p, { relation, value: meetPerRequest(e.cached) });
  const cached = plainFreshnessDecision(p, { relation, value: e.cached });
  // Every change evicts: `evicted`. Some change does not: both kinds happen.
  return evicted === everyChange(evicted, cached) ? evicted : "overlap";
};

/**
 * Decides an effect's freshness against a premise's. A premise in the
 * invalidation form is not one `readClaim` reads; met here, it needs a probe.
 */
export const freshnessDecision = (
  p: { readonly relation: ClaimRelation; readonly value: FreshnessValue },
  e: { readonly relation: ClaimRelation; readonly value: FreshnessValue },
): RegionDecision => {
  const premise = p.value;
  if (isInvalidated(premise)) return "overlap";
  const held = { relation: p.relation, value: premise };
  return isInvalidated(e.value)
    ? invalidationDecision(held, e.relation, e.value)
    : plainFreshnessDecision(held, { relation: e.relation, value: e.value });
};

// -------------------------------------------------------------- consistency

/** eventual < bounded(t) < read-your-writes < linearizable; a smaller t is stronger. */
export type Consistency =
  | "eventual"
  | "read-your-writes"
  | "linearizable"
  | { readonly bounded: number };

const consistencyPosition = (v: Consistency): number =>
  typeof v === "object"
    ? -v.bounded
    : v === "eventual"
      ? Number.NEGATIVE_INFINITY
      : v === "read-your-writes"
        ? 1
        : 2;

export const consistencyLeq = (a: Consistency, b: Consistency): boolean =>
  consistencyPosition(a) <= consistencyPosition(b);

const validConsistency = (v: Consistency): boolean =>
  typeof v !== "object" || (Number.isFinite(v.bounded) && v.bounded >= 0);

export const consistencyDecision = (
  p: { readonly relation: ClaimRelation; readonly value: Consistency },
  e: { readonly relation: ClaimRelation; readonly value: Consistency },
): RegionDecision => {
  if (!validConsistency(p.value) || !validConsistency(e.value)) return "overlap";
  if (involvesNot(p, e)) return notDecision(p, e);
  const bottom = Number.NEGATIVE_INFINITY;
  return intervalDecision(
    interval(p.relation, consistencyPosition(p.value), bottom, 2),
    interval(e.relation, consistencyPosition(e.value), bottom, 2),
  );
};

// -------------------------------------------------------------------- bound

/** A numeric bound in a unit; bounds in different units cannot be compared. */
export type Bound = { readonly n: number; readonly unit: string };

export const boundDecision = (
  p: { readonly relation: ClaimRelation; readonly value: Bound },
  e: { readonly relation: ClaimRelation; readonly value: Bound },
): RegionDecision => {
  if (p.value.unit !== e.value.unit) return "overlap";
  if (involvesNot(p, e)) return notDecision(p, e);
  const inf = Number.POSITIVE_INFINITY;
  return intervalDecision(
    interval(p.relation, p.value.n, -inf, inf),
    interval(e.relation, e.value.n, -inf, inf),
  );
};

// ----------------------------------------------------- finite partial orders

/**
 * Cardinality, ordered by permissiveness: exactly-once is the strongest
 * guarantee and any the weakest; at-most-once and at-least-once are
 * incomparable, so a retry (at-least-once) contradicts a reliance on
 * at-most-once.
 */
export type Cardinality = "exactly-once" | "at-most-once" | "at-least-once" | "any";

export const cardinalities: readonly Cardinality[] = [
  "exactly-once",
  "at-most-once",
  "at-least-once",
  "any",
];

export const cardinalityLeq = (a: Cardinality, b: Cardinality): boolean =>
  a === b || a === "exactly-once" || b === "any";

const finiteRegion = <V>(
  all: readonly V[],
  leq: (a: V, b: V) => boolean,
  relation: ClaimRelation,
  v: V,
): readonly V[] =>
  all.filter((x) =>
    relation === "at-most"
      ? leq(x, v)
      : relation === "at-least"
        ? leq(v, x)
        : relation === "not"
          ? x !== v
          : x === v,
  );

const finiteDecision = <V>(premise: readonly V[], effect: readonly V[]): RegionDecision =>
  effect.every((x) => premise.includes(x))
    ? "within"
    : effect.some((x) => premise.includes(x))
      ? "overlap"
      : "disjoint";

export const finiteOrderDecision = <V>(
  all: readonly V[],
  leq: (a: V, b: V) => boolean,
  p: { readonly relation: ClaimRelation; readonly value: V },
  e: { readonly relation: ClaimRelation; readonly value: V },
): RegionDecision =>
  finiteDecision(
    finiteRegion(all, leq, p.relation, p.value),
    finiteRegion(all, leq, e.relation, e.value),
  );

/** Values with no order between them: presence, purity, idempotence. */
export const booleans: readonly boolean[] = [true, false];

export const discreteLeq = <V>(a: V, b: V): boolean => a === b;

// ---------------------------------------------------------------- authority

/** Who writes the subject. Ordered by ⊆: `at-most {w}` is "w is the single writer". */
export type Authority = { readonly writers: readonly string[] };

export const authorityLeq = (a: Authority, b: Authority): boolean =>
  a.writers.every((w) => b.writers.includes(w));

type WriterInterval = { readonly lo: readonly string[]; readonly hi: readonly string[] | "all" };

const writerInterval = (relation: ClaimRelation, v: Authority): WriterInterval =>
  relation === "at-most"
    ? { lo: [], hi: v.writers }
    : relation === "at-least"
      ? { lo: v.writers, hi: "all" }
      : { lo: v.writers, hi: v.writers };

const within = (xs: readonly string[], ys: readonly string[] | "all"): boolean =>
  ys === "all" || xs.every((x) => ys.includes(x));

export const authorityDecision = (
  p: { readonly relation: ClaimRelation; readonly value: Authority },
  e: { readonly relation: ClaimRelation; readonly value: Authority },
): RegionDecision => {
  const pi = writerInterval(p.relation, p.value);
  const ei = writerInterval(e.relation, e.value);
  const eWithinP =
    within(pi.lo, ei.lo) && (pi.hi === "all" || (ei.hi !== "all" && within(ei.hi, pi.hi)));
  if (eWithinP) return "within";
  const lo = [...pi.lo, ...ei.lo];
  const hi =
    pi.hi === "all" ? ei.hi : ei.hi === "all" ? pi.hi : pi.hi.filter((w) => ei.hi.includes(w));
  return within(lo, hi) ? "overlap" : "disjoint";
};

// ----------------------------------------------------------------- ordering

/** `before` happens before `after`. */
export type Ordering = { readonly before: string; readonly after: string };

export const orderingDecision = (p: Ordering, e: Ordering): RegionDecision =>
  p.before === e.before && p.after === e.after
    ? "within"
    : p.before === e.after && p.after === e.before
      ? "disjoint"
      : "unrelated";
