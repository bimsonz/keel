import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  compare,
  type GuardedTenet,
  type HeldPremise,
  type ProbeCost,
  probeCost,
  type Proposition,
  rankBets,
} from "../../../src/domain/coordination/index.ts";
import { makeId } from "../../../src/domain/kernel/index.ts";
import { key } from "../../arbitraries/coordination.ts";
import { changeIdArb, changeIds, graphPropositionArb } from "../../arbitraries/graph.ts";
import { fc } from "../../support/fast-check.ts";

const cost = (n: number): ProbeCost => Result.getOrThrow(probeCost(n));
/** A cost that depends only on what the premise is about, never on its narrative. */
const costOf = (p: HeldPremise): ProbeCost => cost(1 + (p.proposition.subject.length % 3));

/** Premises drawn from a small pool of claims, so that several stand on one another. */
const worldArb = fc.array(graphPropositionArb, { minLength: 1, maxLength: 3 }).chain((pool) =>
  fc.record({
    premises: fc.array(
      fc.record({
        holder: changeIdArb,
        proposition: fc
          .tuple(fc.constantFrom(...pool), fc.constantFrom("must" as const, "should" as const))
          .map(([p, strength]): Proposition => ({ ...p, strength })),
      }),
      { maxLength: 7 },
    ),
    tenets: fc.array(
      fc
        .tuple(fc.constantFrom(...pool), fc.boolean(), fc.integer({ min: 1, max: 9 }))
        .map(([proposition, withGuard, n]): GuardedTenet => ({
          id: makeId("tnt", String(n).padStart(26, "0")),
          proposition,
          guards: withGuard ? [makeId("grd", String(n).padStart(26, "0"))] : [],
        })),
      { maxLength: 2 },
    ),
  }),
);

const isGuarded = (p: HeldPremise, tenets: readonly GuardedTenet[]): boolean =>
  tenets.some(
    (t) => t.guards.length > 0 && compare(p.proposition, t.proposition).outcome === "compatible",
  );

const standingOn = (p: HeldPremise, premises: readonly HeldPremise[]): readonly HeldPremise[] =>
  premises.filter(
    (o) =>
      (o.proposition.strength ?? "must") === "must" &&
      compare(p.proposition, o.proposition).outcome === "compatible",
  );

const cheap = (p: HeldPremise): ProbeCost => cost(p.holder === changeIds[1] ? 1 : 10);

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

describe("bets", () => {
  it("[bets.exactly-unguarded] a premise is a bet exactly when no guarded tenet speaks for all of it", () => {
    let guardedSeen = 0;
    fc.assert(
      fc.property(worldArb, ({ premises, tenets }) => {
        const bets = rankBets(premises, tenets, costOf).map((b) => b.premise);
        const expected = premises.filter((p) => !isGuarded(p, tenets));
        guardedSeen += premises.length - expected.length;
        return bets.length === expected.length && expected.every((p) => bets.includes(p));
      }),
    );
    expect(guardedSeen).toBeGreaterThan(0);
    const g1: GuardedTenet = {
      id: makeId("tnt", "0".repeat(25) + "1"),
      proposition: { ...premiseA.proposition, relation: "is", value: "per-call" },
      guards: [makeId("grd", "0".repeat(25) + "1")],
    };
    expect(rankBets([premiseA], [], costOf).length).toBe(1);
    expect(rankBets([premiseA], [g1], costOf).length).toBe(0);
  });

  it("[bets.blast-counts-standing] blast is the changes plus the must premises that fail whenever the bet does", () => {
    let shared = 0;
    fc.assert(
      fc.property(worldArb, ({ premises, tenets }) =>
        rankBets(premises, tenets, costOf).every((bet) => {
          const standing = standingOn(bet.premise, premises);
          if (standing.length > 1) shared++;
          return bet.blast === new Set(standing.map((s) => s.holder)).size + standing.length;
        }),
      ),
    );
    expect(shared).toBeGreaterThan(0);
    const second: HeldPremise = { ...premiseA, holder: changeIds[1]! };
    expect(rankBets([premiseA, second], [], costOf).map((b) => b.blast)).toEqual([4, 4]);
  });

  it("[bets.ranked-by-blast-per-cost] bets come highest blast ÷ cost first", () => {
    fc.assert(
      fc.property(worldArb, ({ premises, tenets }) => {
        const scores = rankBets(premises, tenets, costOf).map((b) => b.blast / b.cost);
        return scores.every((s, i) => i === 0 || (scores[i - 1] ?? s) >= s);
      }),
    );
    const other: HeldPremise = {
      ...premiseA,
      holder: changeIds[1]!,
      proposition: { ...premiseA.proposition, subject: key("billing") },
    };
    expect(rankBets([premiseA, other], [], cheap).map((b) => b.premise.holder)).toEqual([
      changeIds[1],
      changeIds[0],
    ]);
  });

  it("[bets.only-must-counts] should premises never add blast to any bet", () => {
    fc.assert(
      fc.property(
        worldArb,
        graphPropositionArb,
        changeIdArb,
        ({ premises, tenets }, extra, holder) => {
          const should: HeldPremise = { holder, proposition: { ...extra, strength: "should" } };
          const before = new Map(
            rankBets(premises, tenets, costOf).map((b) => [b.premise, b.blast]),
          );
          return rankBets([...premises, should], tenets, costOf).every(
            (b) => b.premise === should || b.blast === before.get(b.premise),
          );
        },
      ),
    );
    const should: HeldPremise = {
      ...premiseA,
      proposition: { ...premiseA.proposition, strength: "should" },
    };
    expect(rankBets([should], [], costOf).map((b) => b.blast)).toEqual([0]);
  });

  it("[bets.narrative-never-counts] gloss, citations and anchors never change the ranking", () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.array(fc.string(), { minLength: 7, maxLength: 7 }),
        ({ premises, tenets }, glosses) => {
          const narrated = premises.map((p, i): HeldPremise => ({
            ...p,
            proposition: { ...p.proposition, gloss: glosses[i] ?? "" },
          }));
          const plain = rankBets(premises, tenets, costOf).map((b) => [
            b.premise.holder,
            b.blast,
            premises.indexOf(b.premise),
          ]);
          const told = rankBets(narrated, tenets, costOf).map((b) => [
            b.premise.holder,
            b.blast,
            narrated.indexOf(b.premise),
          ]);
          expect(told).toEqual(plain);
        },
      ),
    );
  });

  it("[bets.probe-cost-positive] a probe cost must be positive and finite", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(Result.isFailure(probeCost(bad))).toBe(true);
    fc.assert(
      fc.property(fc.double({ min: 1e-9, max: 1e9, noNaN: true }), (n) =>
        Result.isSuccess(probeCost(n)),
      ),
    );
  });
});
