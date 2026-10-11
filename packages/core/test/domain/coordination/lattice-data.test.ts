import { describe, expect, it } from "vitest";
import {
  booleans,
  cardinalities,
  cardinalityLeq,
  type Consistency,
  consistencyLeq,
  type Freshness,
  freshnessLeq,
  LATTICES,
  type Lattice,
  type LatticeCover,
  Predicate,
} from "../../../src/domain/coordination/index.ts";
import { fc } from "../../support/fast-check.ts";

/** `lower ≤ upper` by the covers' reflexive-transitive closure. */
function closure(covers: readonly LatticeCover[]): (lower: string, upper: string) => boolean {
  const above = (id: string) => covers.filter((c) => c.lower === id).map((c) => c.upper);
  return (lower, upper) => {
    const seen = new Set<string>();
    const queue = [lower];
    while (queue.length > 0) {
      const id = queue.shift() ?? "";
      if (id === upper) return true;
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(...above(id));
      }
    }
    return false;
  };
}

function lattice(predicate: Predicate): Lattice {
  const found = LATTICES.find((l) => l.predicate === predicate);
  if (found === undefined) throw new Error(`no lattice for ${predicate}`);
  return found;
}

const freshnessNode = (v: Freshness): string => (typeof v === "object" ? "ttl:<n>" : v);
const consistencyNode = (v: Consistency): string => (typeof v === "object" ? "bounded:<t>" : v);

const ttl = fc.nat({ max: 86_400 }).map((n): Freshness => ({ ttl: n }));
const freshness = fc.oneof(
  fc.constantFrom<Freshness>("per-call", "per-request", "per-session", "static"),
  ttl,
);
const consistency = fc.oneof(
  fc.constantFrom<Consistency>("eventual", "read-your-writes", "linearizable"),
  fc.nat({ max: 10_000 }).map((t): Consistency => ({ bounded: t })),
);

describe("the published lattices", () => {
  it("[lattice.published] each finite order's covers close to exactly its leq; a family orders by its parameter", () => {
    const fresh = lattice("freshness");
    const freshLeq = closure(fresh.covers);
    const freshFamily = fresh.values.find((v) => v.family !== undefined)?.family;
    fc.assert(
      fc.property(freshness, freshness, (a, b) => {
        const drawn =
          typeof a === "object" && typeof b === "object"
            ? freshFamily?.higher === "larger"
              ? a.ttl <= b.ttl
              : a.ttl >= b.ttl
            : freshLeq(freshnessNode(a), freshnessNode(b));
        // A pair the lattice cannot settle ("unknown") has no edge.
        return drawn === (freshnessLeq(a, b) === true);
      }),
    );
    const cons = lattice("consistency");
    const consLeq = closure(cons.covers);
    const consFamily = cons.values.find((v) => v.family !== undefined)?.family;
    fc.assert(
      fc.property(consistency, consistency, (a, b) => {
        const drawn =
          typeof a === "object" && typeof b === "object"
            ? consFamily?.higher === "larger"
              ? a.bounded <= b.bounded
              : a.bounded >= b.bounded
            : consLeq(consistencyNode(a), consistencyNode(b));
        return drawn === consistencyLeq(a, b);
      }),
    );
    const card = closure(lattice("cardinality").covers);
    for (const a of cardinalities)
      for (const b of cardinalities)
        expect([a, b, card(a, b)]).toEqual([a, b, cardinalityLeq(a, b)]);
    for (const predicate of ["presence", "purity", "idempotent"] as const)
      expect(lattice(predicate)).toEqual({
        predicate,
        values: booleans.map((b) => ({ id: String(b) })),
        covers: [],
      });
  });

  it("[lattice.hasse] every cover is an edge of the Hasse diagram: none is implied by the others, each joins two values", () => {
    for (const { predicate, values, covers } of LATTICES) {
      const ids = new Set(values.map((v) => v.id));
      for (const [i, c] of covers.entries()) {
        expect([predicate, ids.has(c.lower) && ids.has(c.upper)]).toEqual([predicate, true]);
        const others = covers.filter((_, j) => j !== i);
        expect([predicate, c, closure(others)(c.lower, c.upper)]).toEqual([predicate, c, false]);
      }
    }
  });

  it("[lattice.every-predicate] publishes one lattice per predicate, in the order Predicate lists them", () => {
    expect(LATTICES.map((l) => l.predicate)).toEqual([...Predicate.literals]);
  });
});
