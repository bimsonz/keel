import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canBlock,
  canonicalJson,
  contentHashOf,
  EvidenceClass,
  globsMayOverlap,
  type Json,
  matchesGlob,
  sha256Hex,
  weakest,
} from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const reference = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("sha256", () => {
  it("[kernel.sha256-fips-vectors] matches the FIPS 180-4 examples", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("[kernel.sha256-matches-reference] agrees with node:crypto on any string, lone surrogates included", () => {
    const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((n) => String.fromCharCode(n));
    const text = fc.oneof(fc.string({ unit: codeUnit, maxLength: 200 }), fc.string({ unit: "grapheme", maxLength: 200 }));
    fc.assert(
      fc.property(text, (s) => {
        expect(sha256Hex(s)).toBe(reference(s));
      }),
    );
  });
});

/** Rebuilds every object with its keys in a pseudo-random order. */
const shuffle = (value: Json, rand: () => number): Json => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v: Json) => shuffle(v, rand));
  const entries = Object.entries(value)
    .map(([k, v]) => [k, shuffle(v, rand), rand()] as const)
    .toSorted((x, y) => x[2] - y[2])
    .map(([k, v]) => [k, v] as const);
  return Object.fromEntries(entries);
};

const jsonValue: fc.Arbitrary<Json> = fc.letrec<{ json: Json }>((tie) => ({
  json: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.array(tie("json"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("json"), { maxKeys: 4 }),
  ),
})).json;

describe("canonical JSON", () => {
  it("[kernel.canonical-json-rfc8785] produces the RFC 8785 (JCS) example output", () => {
    // The RFC's input text, parsed as JSON, so its number literals reach the encoder as written.
    const rfcInput = String.raw`{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/", "literals": [null, true, false]}`;
    const input: Json = JSON.parse(rfcInput);
    expect(canonicalJson(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
    expect(contentHashOf(input)).toBe(`sha256:${reference(canonicalJson(input))}`);
  });

  it("[kernel.canonical-json-key-order] is independent of key insertion order and loses nothing", () => {
    fc.assert(
      fc.property(jsonValue, fc.integer(), (json, seed) => {
        let state = seed;
        const rand = (): number => {
          state = (state * 1103515245 + 12345) & 0x7fffffff;
          return state / 0x7fffffff;
        };
        expect(canonicalJson(shuffle(json, rand))).toBe(canonicalJson(json));
        expect(JSON.parse(canonicalJson(json))).toEqual(JSON.parse(JSON.stringify(json)));
      }),
    );
  });
});

// An independent oracle: the glob as a regular expression over `path + "/"`.
const segmentRegex = (segment: string): string =>
  segment
    .split("")
    .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");

const oracle = (glob: string, p: string): boolean => {
  const body = glob
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => (s === "**" ? "(?:[^/]+/)*" : `${segmentRegex(s)}/`))
    .join("");
  return new RegExp(`^${body}$`).test(`${p}/`);
};

describe("globs", () => {
  const segment = fc.constantFrom("a", "b", "ab", "ba");
  const path = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join("/"));
  const patternSegment = fc.constantFrom("a", "b", "ab", "*", "?", "a*", "*b", "**");
  const pattern = fc.array(patternSegment, { minLength: 1, maxLength: 3 }).map((s) => s.join("/"));
  const allPaths = (() => {
    const segs = ["a", "b", "ab", "ba"];
    const out: string[] = [];
    const walk = (prefix: string[]): void => {
      if (prefix.length > 0) out.push(prefix.join("/"));
      if (prefix.length < 3) for (const s of segs) walk([...prefix, s]);
    };
    walk([]);
    return out;
  })();

  it("[kernel.glob-matches-oracle] agrees with a regular-expression oracle", () => {
    fc.assert(
      fc.property(pattern, path, (g, p) => {
        expect(matchesGlob(g, p)).toBe(oracle(g, p));
      }),
    );
  });

  it("[kernel.glob-overlap-sound] never says two globs are disjoint when some path matches both", () => {
    let overlapping = 0;
    fc.assert(
      fc.property(pattern, pattern, (a, b) => {
        const witness = allPaths.find((p) => matchesGlob(a, p) && matchesGlob(b, p));
        if (witness !== undefined) overlapping++;
        return witness === undefined || globsMayOverlap(a, b);
      }),
    );
    expect(overlapping).toBeGreaterThan(0);
  });
});

const evidenceClasses = EvidenceClass.literals;
const rank = (c: EvidenceClass): number => ["opinion", "testimony", "ruling", "proof"].indexOf(c);

describe("evidence classes", () => {
  const cls = fc.constantFrom(...evidenceClasses);

  it("[kernel.evidence-weakest-is-meet] weakest is the lighter of the two, commutative and idempotent", () => {
    fc.assert(
      fc.property(cls, cls, (a, b) => {
        const w = weakest(a, b);
        expect(rank(w)).toBe(Math.min(rank(a), rank(b)));
        expect(weakest(b, a)).toBe(w);
        expect(weakest(a, a)).toBe(a);
      }),
    );
  });

  it("[kernel.only-proof-or-ruling-decide] only proof and rulings can block or clear", () => {
    expect(evidenceClasses.filter(canBlock).toSorted()).toEqual(["proof", "ruling"]);
  });
});
