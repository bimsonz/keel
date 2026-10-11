/**
 * What crosses the wire decodes only in the shapes Keel commits to: finite
 * numbers (JSON turns NaN and ±Infinity into null), and records whose fields
 * depend on each other.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DecisionModelEffect,
  DerivedEffect,
  InvalidProbeCost,
  PlanCompiled,
  Proposition,
} from "../../src/domain/coordination/index.ts";
import { TrunkAdvanced } from "../../src/domain/integration/index.ts";
import { CommitSha, InstantSchema, makeId } from "../../src/domain/kernel/index.ts";
import { Tenet, TenetEstablished } from "../../src/domain/memory/index.ts";
import {
  GateThreshold,
  GuardFailed,
  OpinionAsk,
  StepResult,
  VerificationPlan,
  WorldCheckRan,
} from "../../src/domain/verification/index.ts";
import { fc } from "../support/fast-check.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const decodes =
  (schema: Schema.Codec<unknown>) =>
  (value: unknown): boolean => {
    try {
      Schema.decodeUnknownSync(schema)(value);
      return true;
    } catch {
      return false;
    }
  };

/** Each numeric field that crosses the wire, with a finite value it accepts. */
const NUMBERS: readonly (readonly [string, Schema.Codec<unknown>, number])[] = [
  ["Instant", InstantSchema, 1_760_000_000_000],
  ["DerivedEffect.p", DecisionModelEffect.fields.p, 0.6],
  ["PlanCompiled.costEstimate", PlanCompiled.fields.costEstimate, 12.5],
  ["Proposition.value", Proposition.fields.value, 300],
  ["InvalidProbeCost.cost", InvalidProbeCost.fields.cost, -1],
  ["Tenet.value", Tenet.fields.value, 300],
  ["TenetEstablished.value", TenetEstablished.fields.value, 300],
  ["VerificationPlan.costEstimate", VerificationPlan.fields.costEstimate, 12.5],
  ["StepResult.durationMs", StepResult.fields.durationMs, 5],
  ["OpinionAsk.violating", OpinionAsk.fields.violating, 0.6],
  ["OpinionAsk.compatible", OpinionAsk.fields.compatible, 0.3],
  ["GateThreshold.raise", GateThreshold.fields.raise, 0.65],
  ["GateThreshold.floor", GateThreshold.fields.floor, 0.65],
  ["WorldCheckRan.run", WorldCheckRan.fields.run, 1],
  ["TrunkAdvanced.height", TrunkAdvanced.fields.height, 3],
];
const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const CONFLICT = makeId("cfl", ulid(1));
const CHANGE = makeId("chg", ulid(2));
const check = (outcome: string, extra: object = {}) => ({
  _tag: "WorldCheckRan",
  conflictId: CONFLICT,
  world: "AB",
  check: `suite:${CHANGE}`,
  run: 1,
  outcome,
  ...extra,
});

const GUARD = makeId("grd", ulid(3));
const guardFailed = (extra: object) => ({
  _tag: "GuardFailed",
  guardId: GUARD,
  world: "AB",
  ...extra,
});
const BATCH = { batchId: makeId("bat", ulid(4)) };
const CANDIDATE = { candidateId: makeId("cnd", ulid(5)) };

const ANCHOR = { path: "src/authz/cache.ts", commit: CommitSha.make("c".repeat(40)) };
const effect = (fields: object) => ({
  proposition: {
    subject: "authz.permission-evaluation",
    predicate: "freshness",
    relation: "is",
    value: "per-session",
  },
  anchors: [ANCHOR],
  declared: false,
  ...fields,
});

describe("the wire", () => {
  it("[wire.finite] every number that crosses the wire refuses NaN and ±Infinity at decode", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NUMBERS),
        fc.constantFrom(...NON_FINITE),
        ([, schema, ok], bad) => decodes(schema)(ok) && !decodes(schema)(bad),
      ),
    );
    const refusing = NUMBERS.filter(([, schema]) =>
      NON_FINITE.every((bad) => !decodes(schema)(bad)),
    );
    expect(refusing.map(([name]) => name)).toEqual(NUMBERS.map(([name]) => name));
  });

  it("[events.world-check-na-reason] a suite cell that did not apply says why; one that ran need not", () => {
    const decodesCheck = decodes(WorldCheckRan);
    expect(decodesCheck(check("n/a"))).toBe(false);
    expect(decodesCheck(check("n/a", { reason: "no fixture in A-noop" }))).toBe(true);
    expect(decodesCheck(check("pass", { counts: { passed: 12, failed: 0, skipped: 1 } }))).toBe(
      true,
    );
    expect(decodesCheck(check("fail", { run: 4 }))).toBe(false);
    expect(decodesCheck(check("pass", { check: "probe:prb_1" }))).toBe(false);
  });

  it("[events.guard-failed-shape] a guard fails against a change, or against a batch and its candidate", () => {
    const decodesGuard = decodes(GuardFailed);
    expect(decodesGuard(guardFailed({ changeId: CHANGE }))).toBe(true);
    expect(decodesGuard(guardFailed({ ...BATCH, ...CANDIDATE }))).toBe(true);
    expect(decodesGuard(guardFailed({}))).toBe(false);
    expect(decodesGuard(guardFailed(BATCH))).toBe(false);
    expect(decodesGuard(guardFailed(CANDIDATE))).toBe(false);
  });

  it("[derivation.record-shape] a derived effect's method fixes its evidence class and probability: an extractor rules and carries no p, a decision model is opinion with p in [0, 1]", () => {
    const decodesEffect = decodes(DerivedEffect);
    expect(decodesEffect(effect({ method: "extractor", evidenceClass: "ruling" }))).toBe(true);
    expect(decodesEffect(effect({ method: "clef", evidenceClass: "opinion", p: 0.603 }))).toBe(
      true,
    );
    expect(decodesEffect(effect({ method: "code-model", evidenceClass: "opinion" }))).toBe(true);
    const refused = [
      effect({ method: "extractor", evidenceClass: "proof" }),
      effect({ method: "clef", evidenceClass: "opinion" }),
      effect({ method: "clef", evidenceClass: "ruling", p: 0.9 }),
      effect({ method: "clef", evidenceClass: "opinion", p: 1.2 }),
      effect({ method: "code-model", evidenceClass: "opinion", p: -0.1 }),
      effect({ method: "code-model", evidenceClass: "testimony" }),
      { ...effect({ method: "extractor", evidenceClass: "ruling" }), anchors: [] },
    ];
    expect(refused.filter(decodesEffect)).toEqual([]);
    // An extractor has no probability: one given is dropped at decode, never carried.
    const ruled = Schema.decodeUnknownSync(DerivedEffect)(
      effect({ method: "extractor", evidenceClass: "ruling", p: 0.9 }),
    );
    expect(ruled).not.toHaveProperty("p");
  });
});
