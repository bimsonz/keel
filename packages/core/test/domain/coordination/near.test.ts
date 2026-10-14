import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CoordinationEvent,
  footprintPrefix,
  Preflight,
  PreflightIssued,
} from "../../../src/domain/coordination/index.ts";
import { globsMayOverlap } from "../../../src/domain/kernel/index.ts";
import { changeIds } from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";

/** One prefix an ancestor-or-self of the other, segment by segment: where the index looks a glob up. */
const comparable = (a: readonly string[], b: readonly string[]): boolean => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((segment, i) => segment === long[i]);
};

/** Globs and paths from a small alphabet, so literal paths, prefixes and wildcards meet often; a leading or doubled `/` too. */
const globArb = fc
  .tuple(
    fc.array(
      fc.constantFrom("src", "authz", "billing", "a", "*", "**", "*.ts", "check.ts", "c?eck.ts"),
      {
        minLength: 1,
        maxLength: 4,
      },
    ),
    fc.constantFrom("", "/"),
    fc.boolean(),
  )
  .map(([segments, lead, doubled]) => lead + segments.join(doubled ? "//" : "/"));

describe("near keys", () => {
  it("[t694.glob-prefix] two globs that may overlap have prefixes on one line: one an ancestor-or-self of the other", () => {
    let overlapping = 0;
    fc.assert(
      fc.property(globArb, globArb, (a, b) => {
        if (!globsMayOverlap(a, b)) return true;
        overlapping++;
        return comparable(footprintPrefix(a), footprintPrefix(b));
      }),
    );
    expect(overlapping).toBeGreaterThan(0);
    // A wildcard path's prefix stops at its first wildcard; a literal path is all of itself.
    expect(footprintPrefix("src/authz/*.ts")).toEqual(["src", "authz"]);
    expect(footprintPrefix("src/authz/check.ts")).toEqual(["src", "authz", "check.ts"]);
    expect(footprintPrefix("**/check.ts")).toEqual([]);
  });

  it("[t694.compared-optional] a PreflightIssued from before `compared` still decodes, and one with it keeps it", () => {
    const preflight = {
      neighbours: [],
      contradictions: [],
      precedents: [],
      suggestedMove: "proceed",
    };
    const compared = { changes: 3, subjects: 1 };
    const old = { _tag: "PreflightIssued", changeId: changeIds[0], revision: 1, ...preflight };
    const counted = { ...old, compared };
    expect(Schema.decodeUnknownSync(CoordinationEvent)(old)).toEqual(old);
    expect(Schema.decodeUnknownSync(PreflightIssued)(counted)).toEqual(counted);
    // A retry answers the stored event back as the preflight it issued.
    expect(Schema.decodeUnknownSync(Preflight)(counted)).toEqual({ ...preflight, compared });
    expect(Schema.is(PreflightIssued)({ ...old, compared: { changes: -1, subjects: 0 } })).toBe(
      false,
    );
  });
});
