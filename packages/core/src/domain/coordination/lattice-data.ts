/**
 * Each predicate's lattice as data, for a reader that draws it: Mission Control
 * publishes it through `GET /v1/lattices`. The order is the one claims are read
 * on (`at-most v` is everything at or below v), so `lower ≤ upper` means what
 * `freshnessLeq`, `consistencyLeq` and `cardinalityLeq` say; a test keeps the
 * covers' closure equal to them. The freshness effect form "cached, invalidated
 * on E" is not a value on this lattice, so it is not here.
 */
import type { Predicate } from "./proposition.ts";

/**
 * A parametric family drawn as one value, e.g. `ttl:<n>`: its members are
 * ordered by the parameter, and `higher` says which way.
 */
export interface LatticeFamily {
  readonly name: "ttl" | "bounded";
  /** `larger`: a larger parameter sits higher (ttl:10 ≤ ttl:20). */
  readonly higher: "larger" | "smaller";
}

/** A value as a proposition writes it, or a family's placeholder. */
export interface LatticeValue {
  readonly id: string;
  readonly family?: LatticeFamily;
}

/** One edge of the Hasse diagram: `lower` is immediately below `upper`. */
export interface LatticeCover {
  readonly lower: string;
  readonly upper: string;
}

/**
 * A predicate's lattice. Without `shape` it is the finite order its values and
 * covers draw; values with no covers are unordered (presence, purity,
 * idempotent). With `shape` its values are not enumerable: writer sets under ⊆
 * (`set`), numbers per unit (`numeric`), structural types under subtyping
 * (`structural`), before/after pairs (`sequence`), or free text a model compares
 * (`free-form`).
 */
export interface Lattice {
  readonly predicate: Predicate;
  readonly shape?: "set" | "numeric" | "structural" | "sequence" | "free-form";
  readonly values: readonly LatticeValue[];
  readonly covers: readonly LatticeCover[];
}

const cover = (lower: string, upper: string): LatticeCover => ({ lower, upper });
const open = (predicate: Predicate, shape: NonNullable<Lattice["shape"]>): Lattice => ({
  predicate,
  shape,
  values: [],
  covers: [],
});
const unordered = (predicate: Predicate): Lattice => ({
  predicate,
  values: [{ id: "true" }, { id: "false" }],
  covers: [],
});

/** Every predicate's lattice, in the order `Predicate` lists them. */
export const LATTICES: readonly Lattice[] = [
  {
    predicate: "freshness",
    values: [
      { id: "per-call" },
      { id: "per-request" },
      { id: "per-session" },
      { id: "ttl:<n>", family: { name: "ttl", higher: "larger" } },
      { id: "static" },
    ],
    // A session can outlive or underlive any TTL: per-session and ttl:<n> are incomparable.
    covers: [
      cover("per-call", "per-request"),
      cover("per-request", "per-session"),
      cover("per-request", "ttl:<n>"),
      cover("per-session", "static"),
      cover("ttl:<n>", "static"),
    ],
  },
  {
    predicate: "cardinality",
    values: [
      { id: "exactly-once" },
      { id: "at-most-once" },
      { id: "at-least-once" },
      { id: "any" },
    ],
    covers: [
      cover("exactly-once", "at-most-once"),
      cover("exactly-once", "at-least-once"),
      cover("at-most-once", "any"),
      cover("at-least-once", "any"),
    ],
  },
  open("ordering", "sequence"),
  {
    predicate: "consistency",
    values: [
      { id: "eventual" },
      { id: "bounded:<t>", family: { name: "bounded", higher: "smaller" } },
      { id: "read-your-writes" },
      { id: "linearizable" },
    ],
    covers: [
      cover("eventual", "bounded:<t>"),
      cover("bounded:<t>", "read-your-writes"),
      cover("read-your-writes", "linearizable"),
    ],
  },
  open("shape", "structural"),
  unordered("presence"),
  open("authority", "set"),
  unordered("purity"),
  unordered("idempotent"),
  open("bound", "numeric"),
  open("invariant", "free-form"),
];
