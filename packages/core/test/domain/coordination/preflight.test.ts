import { describe, expect, it } from "vitest";
import {
  compare,
  type Contradiction,
  type ContradictionRole,
  exposure,
  type Intent,
  type LiveChange,
  type Move,
  type MoveBasis,
  type Neighbour,
  preflight,
  type Proposition,
  type ScopedPrecedent,
} from "../../../src/domain/coordination/index.ts";
import { type ChangeId, Instant, makeId } from "../../../src/domain/kernel/index.ts";
import { comparablePairArb, key, write } from "../../arbitraries/coordination.ts";
import { changeIds, graphPropositionArb, intentArb } from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";

const idAt = (i: number): ChangeId => {
  const id = changeIds[i];
  if (id === undefined) throw new Error(`no change id ${i}`);
  return id;
};
const self = idAt(0);
const other = idAt(1);

const ulid = (n: number): string => String(n).padStart(26, "0");
const decisionIds = [1, 2, 3].map((n) => makeId("dec", ulid(n)));

const must = (p: Proposition): Proposition => ({ ...p, strength: "must" });
const should = (p: Proposition): Proposition => ({ ...p, strength: "should" });
const isMust = (p: Proposition): boolean => (p.strength ?? "must") === "must";

/** A premise and an effect that contradict each other on the lattice. */
const contradictingPairArb = comparablePairArb()
  .map(({ premise, effect }) => ({ premise: write(premise), effect: write(effect) }))
  .filter(({ premise, effect }) => compare(premise, effect).outcome === "contradicts");

/** A contradiction as exposure reports it: either side may hold the premise, and the other side's proposition is a premise or an effect. */
const contradictionArb: fc.Arbitrary<Contradiction> = fc
  .record({
    premise: graphPropositionArb,
    with: graphPropositionArb,
    mine: fc.boolean(),
    withRole: fc.option(fc.constantFrom<ContradictionRole>("premise", "effect"), {
      nil: undefined,
    }),
  })
  .map(({ premise, with: w, mine, withRole }) => ({
    premise,
    with: w,
    holder: mine ? self : other,
    ...(withRole === undefined ? {} : { withRole }),
  }));

const neighbourArb: fc.Arbitrary<Neighbour> = fc.record({
  changeId: fc.constant(other),
  goal: fc.constant("speed up permission checks"),
  subjects: fc.constant([key("authz")]),
  overlap: fc.constantFrom("subject" as const, "footprint" as const),
});

const precedentOf = (n: number, holds: readonly Proposition[]): ScopedPrecedent => {
  const decisionId = decisionIds[n % decisionIds.length];
  if (decisionId === undefined) throw new Error("a decision id");
  return { ref: { decisionId, summary: `decision ${n}`, decidedAt: Instant(0) }, holds };
};

/**
 * Precedents in scope: some uphold nothing typed, some uphold generated
 * propositions, and some uphold one the intent contradicts (planted from a
 * contradicting pair, from either side), so every rule is reached.
 */
const scenarioArb = fc
  .record({
    intent: intentArb,
    contradictions: fc.array(contradictionArb, { maxLength: 4 }),
    neighbours: fc.array(neighbourArb, { maxLength: 2 }),
    held: fc.array(fc.array(graphPropositionArb, { maxLength: 2 }), { maxLength: 2 }),
    planted: fc.option(fc.tuple(contradictingPairArb, fc.boolean()), { nil: undefined, freq: 2 }),
  })
  .map(({ intent, contradictions, neighbours, held, planted }) => {
    const plantedIntent: Intent =
      planted === undefined
        ? intent
        : planted[1]
          ? { ...intent, premises: [...intent.premises, planted[0].premise] }
          : { ...intent, declaredEffects: [...(intent.declaredEffects ?? []), planted[0].effect] };
    const holds = [
      ...held,
      ...(planted === undefined ? [] : [[planted[1] ? planted[0].effect : planted[0].premise]]),
    ];
    return {
      intent: plantedIntent,
      contradictions,
      neighbours,
      precedents: holds.map((h, i) => precedentOf(i, h)),
    };
  });

type Scenario = typeof scenarioArb extends fc.Arbitrary<infer S> ? S : never;
const run = (s: Scenario) =>
  preflight(
    self,
    s.intent,
    { neighbours: s.neighbours, contradictions: s.contradictions },
    s.precedents,
  );

/** Preflight's rule list, read top to bottom: the first rule that matches wins. */
const oracle = (s: Scenario): { readonly move: Move; readonly basis?: MoveBasis } => {
  for (const [i, c] of s.contradictions.entries())
    if (c.holder !== self && isMust(c.premise))
      return { move: "refine", basis: { _tag: "contradiction", index: i } };
  for (const [i, c] of s.contradictions.entries())
    if (c.holder === self && c.withRole !== "premise" && isMust(c.premise))
      return { move: "sequence", basis: { _tag: "contradiction", index: i } };
  for (const p of s.precedents) {
    const premiseBroken = p.holds.some((h) =>
      s.intent.premises.some((mine) => compare(mine, h).outcome === "contradicts"),
    );
    const effectBreaks = p.holds.some((h) =>
      (s.intent.declaredEffects ?? []).some((mine) => compare(h, mine).outcome === "contradicts"),
    );
    if (premiseBroken || effectBreaks)
      return { move: "distinguish", basis: { _tag: "precedent", decisionId: p.ref.decisionId } };
  }
  if (s.contradictions.length > 0)
    return { move: "coordinate", basis: { _tag: "contradiction", index: 0 } };
  return { move: "proceed" };
};

/** A live change holding `premises` and declaring `effects`, with nothing derived yet. */
const live = (
  id: ChangeId,
  premises: readonly Proposition[],
  effects: readonly Proposition[],
): LiveChange => ({
  id,
  intent: { revision: 1, goal: "a change", footprint: [], premises, declaredEffects: effects },
  derived: [],
});

/** The move each side of a pair gets: `a` holds `aPremises` and declares `aEffects`, `b` likewise. */
const movesOf = (a: LiveChange, b: LiveChange): readonly [Move, Move] => [
  preflight(a.id, a.intent, exposure(a.id, a.intent, [b]), []).suggestedMove,
  preflight(b.id, b.intent, exposure(b.id, b.intent, [a]), []).suggestedMove,
];

// The S-1 pair: B relies on revocation taking effect per request; A caches per session.
const S1_PREMISE: Proposition = {
  subject: key("authz.permission-evaluation"),
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
};
const S1_EFFECT: Proposition = { ...S1_PREMISE, relation: "is", value: "per-session" };

describe("preflight: the suggested move, first match wins, ordered by who breaks whom", () => {
  it("[preflight.move-table] the move and what it cites are 03's list read top to bottom", () => {
    const seen = new Set<Move>();
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const got = run(s);
        const want = oracle(s);
        seen.add(got.suggestedMove);
        return (
          got.suggestedMove === want.move &&
          JSON.stringify(got.basis) === JSON.stringify(want.basis) &&
          got.contradictions === s.contradictions &&
          got.neighbours === s.neighbours &&
          JSON.stringify(got.precedents) === JSON.stringify(s.precedents.map((p) => p.ref))
        );
      }),
    );
    expect([...seen].toSorted()).toEqual([
      "coordinate",
      "distinguish",
      "proceed",
      "refine",
      "sequence",
    ]);
    // Both a change I would break and a change that would break me: I refine first.
    const both = run({
      intent: { revision: 1, goal: "g", footprint: [], premises: [] },
      neighbours: [],
      precedents: [],
      contradictions: [
        { premise: S1_PREMISE, with: S1_EFFECT, holder: self, withRole: "effect" },
        { premise: S1_PREMISE, with: S1_EFFECT, holder: other, withRole: "effect" },
      ],
    });
    expect([both.suggestedMove, both.basis]).toEqual([
      "refine",
      { _tag: "contradiction", index: 1 },
    ]);
  });

  it("[preflight.direction] whoever's effect breaks the other's must premise refines, and the one relying sequences", () => {
    fc.assert(
      fc.property(contradictingPairArb, ({ premise, effect }) => {
        const breaker = live(other, [], [effect]);
        const relier = live(self, [must(premise)], []);
        const [a, b] = movesOf(breaker, relier);
        return a === "refine" && b === "sequence";
      }),
    );
    expect(movesOf(live(other, [], [S1_EFFECT]), live(self, [S1_PREMISE], []))).toEqual([
      "refine",
      "sequence",
    ]);
  });

  it("[preflight.must-outranks-should] should-only contradictions coordinate; one must contradiction changes the move", () => {
    fc.assert(
      fc.property(
        fc.array(contradictionArb, { minLength: 1, maxLength: 4 }),
        contradictionArb,
        (cs, extra) => {
          const soft = cs.map((c) => ({ ...c, premise: should(c.premise) }));
          const hard = { ...extra, premise: must(extra.premise), withRole: "effect" as const };
          const base = {
            intent: { revision: 1, goal: "g", footprint: [], premises: [] },
            neighbours: [],
            precedents: [],
          };
          const shouldOnly = run({ ...base, contradictions: soft });
          const withMust = run({ ...base, contradictions: [...soft, hard] });
          return (
            shouldOnly.suggestedMove === "coordinate" &&
            (withMust.suggestedMove === "refine" || withMust.suggestedMove === "sequence")
          );
        },
      ),
    );
    const softPair = movesOf(live(other, [], [S1_EFFECT]), live(self, [should(S1_PREMISE)], []));
    expect(softPair).toEqual(["coordinate", "coordinate"]);
  });

  it("[preflight.neighbour-proceeds] a neighbour with nothing contradicted proceeds, citing nothing", () => {
    fc.assert(
      fc.property(
        fc.array(neighbourArb, { minLength: 1, maxLength: 3 }),
        intentArb,
        fc.array(fc.array(graphPropositionArb, { maxLength: 2 }), { maxLength: 2 }),
        (neighbours, intent, held) => {
          const precedents = held
            .map((h, i) => precedentOf(i, h))
            .filter((p) =>
              p.holds.every(
                (h) =>
                  intent.premises.every((m) => compare(m, h).outcome !== "contradicts") &&
                  (intent.declaredEffects ?? []).every(
                    (m) => compare(h, m).outcome !== "contradicts",
                  ),
              ),
            );
          const got = preflight(self, intent, { neighbours, contradictions: [] }, precedents);
          return got.suggestedMove === "proceed" && got.basis === undefined;
        },
      ),
    );
    const overlap = preflight(
      self,
      { revision: 1, goal: "g", footprint: [], premises: [] },
      {
        neighbours: [{ changeId: other, goal: "h", subjects: [], overlap: "footprint" }],
        contradictions: [],
      },
      [],
    );
    expect(overlap.suggestedMove).toBe("proceed");
  });

  it("[preflight.precedent-distinguish] an intent contradicting what a precedent upheld distinguishes, citing it; one it agrees with is only listed", () => {
    fc.assert(
      fc.property(contradictingPairArb, fc.boolean(), ({ premise, effect }, viaPremise) => {
        const intent: Intent = viaPremise
          ? { revision: 1, goal: "g", footprint: [], premises: [premise] }
          : { revision: 1, goal: "g", footprint: [], premises: [], declaredEffects: [effect] };
        const followed = precedentOf(0, []);
        const contested = precedentOf(1, [viaPremise ? effect : premise]);
        const got = preflight(self, intent, { neighbours: [], contradictions: [] }, [
          followed,
          contested,
        ]);
        const alone = preflight(self, intent, { neighbours: [], contradictions: [] }, [followed]);
        return (
          got.suggestedMove === "distinguish" &&
          got.basis?._tag === "precedent" &&
          got.basis.decisionId === contested.ref.decisionId &&
          got.precedents.length === 2 &&
          alone.suggestedMove === "proceed" &&
          alone.precedents.length === 1
        );
      }),
    );
    const decided = precedentOf(2, [S1_PREMISE]);
    const got = preflight(
      self,
      { revision: 1, goal: "g", footprint: [], premises: [], declaredEffects: [S1_EFFECT] },
      { neighbours: [], contradictions: [] },
      [decided],
    );
    expect([got.suggestedMove, got.basis]).toEqual([
      "distinguish",
      { _tag: "precedent", decisionId: decided.ref.decisionId },
    ]);
  });

  it("[preflight.cites] a move other than proceed cites the earliest item its rule matched, and proceed cites nothing", () => {
    let later = 0;
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const got = run(s);
        const b = got.basis;
        if (got.suggestedMove === "proceed") return b === undefined;
        if (b === undefined) return false;
        if (b._tag === "precedent")
          return (
            got.suggestedMove === "distinguish" &&
            s.precedents.some((p) => p.ref.decisionId === b.decisionId)
          );
        const cited = s.contradictions[b.index];
        if (cited === undefined) return false;
        if (b.index > 0) later++;
        const matches = (c: Contradiction): boolean =>
          got.suggestedMove === "refine"
            ? c.holder !== self && isMust(c.premise)
            : got.suggestedMove === "sequence"
              ? c.holder === self && c.withRole !== "premise" && isMust(c.premise)
              : true;
        return matches(cited) && s.contradictions.slice(0, b.index).every((c) => !matches(c));
      }),
    );
    expect(later).toBeGreaterThan(0);
  });

  it("[preflight.premise-pair] my must premise against another change's premise coordinates, never sequences: neither alters anything", () => {
    fc.assert(
      fc.property(fc.array(contradictionArb, { minLength: 1, maxLength: 4 }), (cs) => {
        const pairs = cs.map((c) => ({
          ...c,
          premise: must(c.premise),
          holder: self,
          withRole: "premise" as const,
        }));
        return (
          run({
            intent: { revision: 1, goal: "g", footprint: [], premises: [] },
            neighbours: [],
            precedents: [],
            contradictions: pairs,
          }).suggestedMove === "coordinate"
        );
      }),
    );
    // Two changes relying on incompatible freshness: each sees the other's premise.
    const per = live(self, [S1_PREMISE], []);
    const cached = live(other, [{ ...S1_EFFECT, relation: "at-least" }], []);
    const [mine] = movesOf(per, cached);
    const reported = exposure(per.id, per.intent, [cached]).contradictions;
    expect(reported.map((c) => c.withRole)).toEqual(["premise"]);
    expect(mine).toBe("coordinate");
  });
});
