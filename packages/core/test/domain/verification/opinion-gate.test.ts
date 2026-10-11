import { describe, expect, it } from "vitest";
import { Predicate } from "../../../src/domain/coordination/index.ts";
import {
  DEFAULT_GATE,
  gateFor,
  type GateOutcome,
  type GateThreshold,
  gateOpinion,
  type OpinionAsk,
} from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";

/** annotate < escalate < suspect: how much scrutiny an outcome adds. */
const band: Readonly<Record<GateOutcome, number>> = { annotate: 0, escalate: 1, suspect: 2 };
const OUTCOMES: readonly string[] = ["suspect", "annotate", "escalate"];

/** Masses drawn densely, with the thresholds themselves and the ends often. */
const massArb = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.constantFrom(0, 0.1, 0.5, 0.603, 0.65, 0.7, 0.75, 0.85, 0.99, 1),
);
/** A well-formed ask: its two masses sum to at most 1, the rest being `unclear`. */
const askArb: fc.Arbitrary<OpinionAsk> = fc
  .tuple(massArb, massArb)
  .map(([violating, share]) => ({ violating, compatible: share * (1 - violating) }));
const asksArb = fc.tuple(askArb, askArb, askArb);
const thresholdArb: fc.Arbitrary<GateThreshold> = fc.record({
  quorum: fc.constantFrom<GateThreshold["quorum"]>("all", "two-of-three"),
  raise: massArb,
  floor: massArb,
});

/** Anything at all: missing asks, the wrong count, non-finite or out-of-range masses. */
const wildMassArb = fc.oneof(
  massArb,
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.5),
);
const wildAsksArb = fc.array(
  fc.option(fc.record({ violating: wildMassArb, compatible: wildMassArb }), { nil: undefined }),
  { minLength: 0, maxLength: 5 },
);
const wildThresholdArb = fc.record({
  quorum: fc.constantFrom<GateThreshold["quorum"]>("all", "two-of-three"),
  raise: wildMassArb,
  floor: wildMassArb,
});

/** The rule, written from ADR 0012, apart from the implementation. */
const votesOf = (asks: readonly OpinionAsk[], t: GateThreshold) => ({
  contradiction: asks.filter((a) => a.violating >= t.raise).length,
  compatible: asks.filter((a) => a.violating < t.raise && a.compatible >= t.floor).length,
});
const needed = (t: GateThreshold): number => (t.quorum === "all" ? 3 : 2);

const withViolating = (asks: readonly OpinionAsk[], i: number, v: number): OpinionAsk[] =>
  asks.map((a, j) =>
    j === i ? { violating: v, compatible: Math.min(a.compatible, 1 - v) } : { ...a },
  );

/** An ask voting contradiction at `t`, one voting compatible, and one abstaining. */
const contradicting = { violating: 0.9, compatible: 0.05 };
const agreeing = { violating: 0.05, compatible: 0.9 };
const unsure = { violating: 0.3, compatible: 0.3 };
const at = (raise: number, quorum: GateThreshold["quorum"] = "all"): GateThreshold => ({
  quorum,
  raise,
  floor: raise,
});

describe("the opinion gate", () => {
  it("[gate.never-blocks] whatever comes in, the gate suspects, annotates or escalates: an opinion never fails or clears", () => {
    fc.assert(
      fc.property(wildAsksArb, wildThresholdArb, (asks, t) =>
        OUTCOMES.includes(gateOpinion(asks, t)),
      ),
    );
    expect(
      gateOpinion([{ violating: 1, compatible: 0 }, contradicting, contradicting], at(0.5)),
    ).toBe("suspect");
  });

  it("[gate.monotone-mass] more violating mass, or less compatible mass, never moves the outcome toward annotate", () => {
    fc.assert(
      fc.property(asksArb, thresholdArb, fc.nat({ max: 2 }), massArb, (asks, t, i, v) => {
        const before = band[gateOpinion(asks, t)];
        const ask = asks[i] ?? contradicting;
        const raised = withViolating(asks, i, Math.max(ask.violating, v));
        const lowered = asks.map((a, j) =>
          j === i ? { ...a, compatible: Math.min(a.compatible, v) } : a,
        );
        return band[gateOpinion(raised, t)] >= before && band[gateOpinion(lowered, t)] >= before;
      }),
    );
    // A third contradiction vote never undoes the two that already suspect.
    expect(gateOpinion([contradicting, contradicting, unsure], at(0.5, "two-of-three"))).toBe(
      "suspect",
    );
    expect(
      gateOpinion([contradicting, contradicting, contradicting], at(0.5, "two-of-three")),
    ).toBe("suspect");
  });

  it("[gate.monotone-threshold] raising raise never raises the outcome, and raising floor never lowers it", () => {
    fc.assert(
      fc.property(asksArb, thresholdArb, massArb, (asks, t, x) => {
        const before = band[gateOpinion(asks, t)];
        const higherRaise = { ...t, raise: Math.max(t.raise, x) };
        const higherFloor = { ...t, floor: Math.max(t.floor, x) };
        return (
          band[gateOpinion(asks, higherRaise)] <= before &&
          band[gateOpinion(asks, higherFloor)] >= before
        );
      }),
    );
    // Raising raise past compatible asks leaves them compatible: the floor, not raise, counts there.
    const annotated = [agreeing, agreeing, agreeing];
    expect(gateOpinion(annotated, { quorum: "all", raise: 0.95, floor: 0.5 })).toBe("annotate");
  });

  it("[gate.quorum] two of three needs two alike votes and all three needs three", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<GateThreshold["quorum"]>("all", "two-of-three"),
        fc.nat({ max: 3 }),
        fc.nat({ max: 3 }),
        (quorum, k, rotate) => {
          const asks = [0, 1, 2].map((j) => ((j + rotate) % 3 < k ? contradicting : unsure));
          const want = k >= (quorum === "all" ? 3 : 2) ? "suspect" : "escalate";
          return gateOpinion(asks, at(0.5, quorum)) === want;
        },
      ),
    );
    expect(gateOpinion([contradicting, contradicting, unsure], at(0.5, "two-of-three"))).toBe(
      "suspect",
    );
    expect(gateOpinion([contradicting, contradicting, unsure], at(0.5, "all"))).toBe("escalate");
  });

  it("[gate.annotate-at-floor] annotate exactly when a quorum of asks put at least floor on compatible values, unclear excluded", () => {
    fc.assert(
      fc.property(asksArb, thresholdArb, (asks, t) => {
        const votes = votesOf(asks, t);
        const want: GateOutcome =
          votes.contradiction >= needed(t)
            ? "suspect"
            : votes.compatible >= needed(t)
              ? "annotate"
              : "escalate";
        return gateOpinion(asks, t) === want;
      }),
    );
    // Mostly unclear: little violating mass is not a compatible answer.
    const unclear = { violating: 0.1, compatible: 0.1 };
    expect(gateOpinion([unclear, unclear, unclear], at(0.5))).toBe("escalate");
    // Exactly at the floor votes compatible.
    const onFloor = { violating: 0.2, compatible: 0.5 };
    expect(gateOpinion([onFloor, onFloor, onFloor], at(0.5))).toBe("annotate");
    // An ask meeting both thresholds votes contradiction.
    const both = { violating: 0.5, compatible: 0.5 };
    expect(gateOpinion([both, both, both], at(0.5))).toBe("suspect");
  });

  it("[gate.abstains-escalate] a missing ask, the wrong number of asks, a malformed mass or threshold escalates", () => {
    fc.assert(
      fc.property(asksArb, thresholdArb, fc.nat({ max: 2 }), (asks, t, i) => {
        const missing = asks.map((a, j) => (j === i ? undefined : a));
        return (
          gateOpinion(missing, t) === "escalate" &&
          gateOpinion([...asks, asks[i]], t) === "escalate" &&
          gateOpinion(asks.slice(1), t) === "escalate" &&
          gateOpinion(asks, { ...t, raise: 1.5 }) === "escalate" &&
          gateOpinion(asks, { ...t, floor: Number.NaN }) === "escalate"
        );
      }),
    );
    const truncated = [undefined, undefined, undefined];
    expect(gateOpinion(truncated, at(0.5))).toBe("escalate");
    expect(gateOpinion([contradicting, contradicting, undefined], at(0.5, "two-of-three"))).toBe(
      "escalate",
    );
    expect(
      gateOpinion([{ violating: 0.9, compatible: 0.9 }, contradicting, contradicting], at(0.5)),
    ).toBe("escalate");
  });

  it("[gate.defaults] the defaults are S17c's, floor equals raise everywhere, and S-1's B′ at 0.603 escalates on freshness", () => {
    const rows = Object.keys(DEFAULT_GATE.predicates);
    expect(rows.every((p) => (Predicate.literals as readonly string[]).includes(p))).toBe(true);
    expect(Predicate.literals.every((p) => gateFor(p).floor === gateFor(p).raise)).toBe(true);
    const shown = Object.fromEntries(
      Predicate.literals.map((p) => [p, `${gateFor(p).quorum} ${gateFor(p).raise}`]),
    );
    expect(shown).toEqual({
      shape: "all 0.5",
      presence: "all 0.5",
      authority: "all 0.5",
      bound: "all 0.5",
      purity: "two-of-three 0.5",
      idempotent: "two-of-three 0.5",
      cardinality: "two-of-three 0.5",
      freshness: "all 0.65",
      ordering: "two-of-three 0.7",
      consistency: "all 0.75",
      invariant: "two-of-three 0.85",
    });
    // F03 in S17c: per-session ×3, violating mass 0.603 to 0.84 over the three asks.
    const bPrime = [
      { violating: 0.603, compatible: 0.39 },
      { violating: 0.72, compatible: 0.27 },
      { violating: 0.84, compatible: 0.15 },
    ];
    expect(gateOpinion(bPrime, gateFor("freshness"))).toBe("escalate");
  });
});
