// Keel's lattices, as `GET /v1/lattices` serves them: each predicate's values
// and the covers that order them. This is the fixtures' copy of what Keel
// publishes (its domain's own data, at the commit in contract/keel/SOURCE.json),
// served by the mock source and the stand-in Keel. The live console reads Keel's.

import type { Lattice, LatticeSet, Predicate } from "../../src/contract/keel/index.ts";

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

export const LATTICES: LatticeSet = {
  items: [
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
        { lower: "per-call", upper: "per-request" },
        { lower: "per-request", upper: "per-session" },
        { lower: "per-request", upper: "ttl:<n>" },
        { lower: "per-session", upper: "static" },
        { lower: "ttl:<n>", upper: "static" },
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
        { lower: "exactly-once", upper: "at-most-once" },
        { lower: "exactly-once", upper: "at-least-once" },
        { lower: "at-most-once", upper: "any" },
        { lower: "at-least-once", upper: "any" },
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
        { lower: "eventual", upper: "bounded:<t>" },
        { lower: "bounded:<t>", upper: "read-your-writes" },
        { lower: "read-your-writes", upper: "linearizable" },
      ],
    },
    open("shape", "structural"),
    unordered("presence"),
    open("authority", "set"),
    unordered("purity"),
    unordered("idempotent"),
    open("bound", "numeric"),
    open("invariant", "free-form"),
  ],
};
