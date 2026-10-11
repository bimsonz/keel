import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  compare,
  type DerivedEffect,
  drift,
  type DriftFinding,
  type FootprintEntry,
  type HeldPremise,
  type Intent,
  isAncestorOrSelf,
  parentSubject,
  type Proposition,
  readScope,
  scopeCovers,
} from "../../../src/domain/coordination/index.ts";
import { type EvidenceClass, Glob, makeId } from "../../../src/domain/kernel/index.ts";
import { key } from "../../arbitraries/coordination.ts";
import {
  changeIdArb,
  changeIds,
  derivedEffectArb,
  footprintArb,
  heldPremiseArb,
  tenetArb,
} from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";

const touchedPaths = [
  "src/authz/check.ts",
  "src/authz/cache.ts",
  "src/billing/charge.ts",
  "docs/readme.md",
] as const;
const touchedArb: fc.Arbitrary<readonly FootprintEntry[]> = fc
  .subarray([...touchedPaths])
  .map((paths) => paths.map((path) => ({ path: Glob.make(path), op: "edit" as const })));

/** Declared effects shaped from the derived ones, so that "declared" is common: the same, a parent's, or a narrower scope's. */
const declaredFrom = (derived: readonly DerivedEffect[]): fc.Arbitrary<readonly Proposition[]> =>
  fc
    .tuple(...derived.map(() => fc.constantFrom("none", "same", "parent", "narrower")))
    .map((choices) =>
      derived.flatMap((d, i): Proposition[] => {
        const p = d.proposition;
        const parent = parentSubject(p.subject);
        switch (choices[i]) {
          case "same":
            return [p];
          case "parent":
            return parent === undefined ? [p] : [{ ...p, subject: parent }];
          case "narrower":
            return [{ ...p, scope: "env:prod;tenant:t1" }];
          default:
            return [];
        }
      }),
    );

const scenarioArb = changeIdArb.chain((self) =>
  fc.array(derivedEffectArb(), { maxLength: 4 }).chain((derived) =>
    fc.record({
      self: fc.constant(self),
      derived: fc.constant(derived),
      declared: declaredFrom(derived),
      footprint: footprintArb,
      touched: touchedArb,
      premises: fc.array(heldPremiseArb, { maxLength: 5 }),
      tenets: fc.array(tenetArb, { maxLength: 2 }),
    }),
  ),
);

type Scenario = {
  readonly self: (typeof changeIds)[number];
  readonly derived: readonly DerivedEffect[];
  readonly declared: readonly Proposition[];
  readonly footprint: readonly FootprintEntry[];
  readonly touched: readonly FootprintEntry[];
  readonly premises: readonly HeldPremise[];
  readonly tenets: readonly Parameters<typeof drift>[5][number][];
};

const intentOf = (s: Scenario): Intent => ({
  revision: 1,
  goal: "speed up permission checks",
  footprint: s.footprint,
  premises: [],
  declaredEffects: s.declared,
});

const run = (s: Scenario): readonly DriftFinding[] =>
  drift(s.self, intentOf(s), s.touched, s.derived, s.premises, s.tenets);

const scopeOf = (p: Proposition) => Result.getOrThrow(readScope(p.scope));

/** The rule, restated: a declared effect on the subject or an ancestor, over at least its scope, that it stays inside. */
const covered = (s: Scenario, e: Proposition): boolean =>
  s.declared.some((d) => {
    const outcome = compare(d, e).outcome;
    return (
      d.predicate === e.predicate &&
      isAncestorOrSelf(d.subject, e.subject) &&
      scopeCovers(scopeOf(d), scopeOf(e)) &&
      (outcome === "compatible" || outcome === "refines")
    );
  });

const retracts = (s: Scenario, e: Proposition): boolean =>
  s.premises.some(
    (p) =>
      p.holder !== s.self &&
      (p.proposition.strength ?? "must") === "must" &&
      compare(p.proposition, e).outcome === "contradicts",
  ) || s.tenets.some((t) => compare(t.proposition, e).outcome === "contradicts");

/** ADR 0005: only proof or a ruling decides. */
const decides = (c: EvidenceClass): boolean => c === "proof" || c === "ruling";

const evaluation = key("authz.permission-evaluation");
const premiseA: HeldPremise = {
  holder: changeIds[0]!,
  proposition: {
    subject: evaluation,
    predicate: "freshness",
    relation: "at-most",
    value: "per-request",
  },
};
const cache = (value: string, evidenceClass: DerivedEffect["evidenceClass"]): DerivedEffect => {
  const proposition = {
    subject: evaluation,
    predicate: "freshness",
    relation: "is",
    value,
  } as const;
  return evidenceClass === "opinion"
    ? { proposition, method: "clef", evidenceClass, p: 0.9, anchors: [], declared: false }
    : { proposition, method: "extractor", evidenceClass, anchors: [], declared: false };
};
const b: Scenario = {
  self: changeIds[1]!,
  derived: [],
  declared: [],
  footprint: [],
  touched: [],
  premises: [premiseA],
  tenets: [],
};

describe("drift", () => {
  it("[drift.opinion-never-blocks] an undeclared effect that is only opinion or testimony never blocks", () => {
    let opinions = 0;
    fc.assert(
      fc.property(scenarioArb, (s) =>
        run(s).every((f) => {
          if (f._tag === "footprint") return !f.blocks;
          if (decides(f.effect.evidenceClass)) return true;
          opinions++;
          return !f.blocks;
        }),
      ),
    );
    expect(opinions).toBeGreaterThan(0);
    const [silent] = run({ ...b, derived: [cache("per-session", "opinion")] });
    expect(silent?.blocks).toBe(false);
  });

  it("[drift.proof-or-ruling-blocks] an undeclared effect blocks when its evidence is proof or a ruling", () => {
    fc.assert(
      fc.property(scenarioArb, (s) =>
        run(s).every((f) => f._tag === "footprint" || f.blocks === decides(f.effect.evidenceClass)),
      ),
    );
    // An extractor's finding is a ruling, and blocks; a model's is opinion, and never does.
    expect(run({ ...b, derived: [cache("per-call", "ruling")] }).map((f) => f.blocks)).toEqual([
      true,
    ]);
    expect(run({ ...b, derived: [cache("per-call", "opinion")] }).map((f) => f.blocks)).toEqual([
      false,
    ]);
  });

  it("[drift.reports-exactly-undeclared] an effect gets a finding exactly when no declared effect speaks for it", () => {
    let declaredSeen = 0;
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const reported = run(s).flatMap((f) => (f._tag === "footprint" ? [] : [f.effect]));
        const expected = s.derived.filter((d) => !covered(s, d.proposition));
        declaredSeen += s.derived.length - expected.length;
        expect(reported).toEqual(expected);
      }),
    );
    expect(declaredSeen).toBeGreaterThan(0);
  });

  it("[drift.silent-retraction-iff-contradicting] an undeclared effect is a silent retraction exactly when it contradicts another change's must premise or a tenet", () => {
    let retractions = 0;
    fc.assert(
      fc.property(scenarioArb, (s) =>
        run(s).every((f) => {
          if (f._tag === "footprint") return true;
          const expected = retracts(s, f.effect.proposition);
          if (expected) retractions++;
          return (f._tag === "silent-retraction") === expected && f.opensConflict === expected;
        }),
      ),
    );
    expect(retractions).toBeGreaterThan(0);
    const should: HeldPremise = {
      ...premiseA,
      proposition: { ...premiseA.proposition, strength: "should" },
    };
    expect(
      run({ ...b, premises: [should], derived: [cache("per-session", "opinion")] }).map(
        (f) => f._tag,
      ),
    ).toEqual(["undeclared-effect"]);
    expect(
      run({ ...b, self: premiseA.holder, derived: [cache("per-session", "opinion")] }).map(
        (f) => f._tag,
      ),
    ).toEqual(["undeclared-effect"]);
    // A tenet binds like a must premise, with no premise held at all; generated scenarios rarely retract one, so pin it.
    const tenet = {
      id: makeId("tnt", "0".repeat(26)),
      proposition: premiseA.proposition,
      guards: [],
    };
    expect(
      run({ ...b, premises: [], tenets: [tenet], derived: [cache("per-session", "opinion")] }).map(
        (f) => f._tag,
      ),
    ).toEqual(["silent-retraction"]);
  });

  it("[drift.footprint-lists-undeclared-paths] footprint drift names exactly the touched paths outside the declared globs", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const f = run(s).find((x) => x._tag === "footprint");
        const outside = s.touched
          .map((t) => t.path)
          .filter((p) => !s.footprint.some((d) => matchesSimple(d.path, p)));
        expect(f?._tag === "footprint" ? f.paths : []).toEqual(outside);
      }),
    );
    const declared: Scenario = {
      ...b,
      footprint: [{ path: Glob.make("src/authz/**"), op: "edit" }],
    };
    const touched: FootprintEntry[] = [
      { path: Glob.make("src/authz/cache.ts"), op: "edit" },
      { path: Glob.make("src/billing/charge.ts"), op: "edit" },
    ];
    const [f] = run({ ...declared, touched });
    expect(f?._tag === "footprint" ? f.paths : undefined).toEqual(["src/billing/charge.ts"]);
  });

  it("[drift.severity-by-class] footprint is low, an undeclared effect medium, a silent retraction high", () => {
    fc.assert(
      fc.property(scenarioArb, (s) =>
        run(s).every(
          (f) =>
            f.drift.class === f._tag &&
            f.drift.severity ===
              { footprint: "low", "undeclared-effect": "medium", "silent-retraction": "high" }[
                f._tag
              ],
        ),
      ),
    );
    expect(
      run({ ...b, derived: [cache("per-session", "opinion")] }).map((f) => f.drift.severity),
    ).toEqual(["high"]);
  });
});

/** The footprint globs the generator uses: `dir/**`, `dir/*.ts`, or a literal path. */
function matchesSimple(glob: string, path: string): boolean {
  if (glob.endsWith("/**")) return path.startsWith(glob.slice(0, -2));
  if (glob.endsWith("/*.ts")) {
    const dir = glob.slice(0, -4);
    return path.startsWith(dir) && !path.slice(dir.length).includes("/") && path.endsWith(".ts");
  }
  return glob === path;
}
