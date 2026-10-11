import { describe, expect, it } from "vitest";
import type { Lattice, Predicate } from "../../../src/contract/keel/index.ts";
import { LATTICES } from "../../fixtures/lattices.ts";
import { chainThrough, valueIdOf } from "../../../src/engine/lattice.ts";

const lattice = (predicate: Predicate): Lattice =>
  LATTICES.items.find((candidate) => candidate.predicate === predicate) ?? {
    predicate,
    values: [],
    covers: [],
  };

describe("a line through one of Keel's lattices", () => {
  it("runs from the least value to the greatest through both values asked for", () => {
    expect(chainThrough(lattice("freshness"), ["per-request", "per-session"])).toEqual([
      "per-call",
      "per-request",
      "per-session",
      "static",
    ]);
    expect(chainThrough(lattice("consistency"), ["eventual", "linearizable"])).toEqual([
      "eventual",
      "bounded:<t>",
      "read-your-writes",
      "linearizable",
    ]);
  });

  it("takes the branch the values are on, where the lattice forks", () => {
    // Freshness forks above per-request: a session on one side, a TTL on the other.
    expect(chainThrough(lattice("freshness"), ["per-request", "ttl:300"])).toEqual([
      "per-call",
      "per-request",
      "ttl:300",
      "static",
    ]);
    expect(chainThrough(lattice("cardinality"), ["exactly-once", "at-least-once"])).toEqual([
      "exactly-once",
      "at-least-once",
      "any",
    ]);
  });

  it("is nothing for two values the lattice does not rank against each other", () => {
    // A session can outlive or underlive any TTL. Only a probe can say.
    expect(chainThrough(lattice("freshness"), ["per-session", "ttl:300"])).toBeNull();
    expect(chainThrough(lattice("cardinality"), ["at-most-once", "at-least-once"])).toBeNull();
  });

  it("is nothing where the lattice has no order to draw, or does not know a value", () => {
    expect(chainThrough(lattice("presence"), ["true", "false"])).toBeNull();
    expect(chainThrough(lattice("bound"), ["10", "20"])).toBeNull();
    expect(chainThrough(lattice("freshness"), ["per-request", "hourly"])).toBeNull();
  });

  it("reads a member of a family as that family's place on the lattice", () => {
    expect(valueIdOf(lattice("freshness"), "ttl:300")).toBe("ttl:<n>");
    expect(valueIdOf(lattice("consistency"), "bounded:5s")).toBe("bounded:<t>");
    expect(valueIdOf(lattice("freshness"), "per-session")).toBe("per-session");
    expect(valueIdOf(lattice("freshness"), "hourly")).toBeUndefined();
  });
});
