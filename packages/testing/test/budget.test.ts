/**
 * A verification's container-minutes: what a plan is admitted, what its
 * reports settle it to, and the verdict of one its namespace refused. Every
 * figure is written out here, never taken from the code under test.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  admitVerification,
  planMinutes,
  settleMinutes,
  settleRefused,
  usedMinutes,
} from "@keeltown/core/application/verification";
import type { PlanStep, StepReport } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { NamespaceUsage } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { makeIdsMemory } from "../src/memory/identity.ts";
import { makeNamespaceUsageMemory } from "../src/memory/namespace-usage.ts";
import { otherNamespace, sampleNamespace } from "../src/namespaces.ts";
import { workerAppPlan } from "../src/plans.ts";

const PLAN_HASH = Schema.decodeUnknownSync(ContentHash)(`sha256:${"c".repeat(64)}`);

/** The worker-app plan: the suite and the typecheck, both in Tier 2. */
const STEPS = workerAppPlan().steps;

const report = (step: PlanStep, durationMs: number, tier = step.tier): StepReport => ({
  stepId: step.id,
  outcome: "pass",
  evidenceClass: step.evidenceCeiling,
  tier,
  durationMs,
});

/** A namespace's container-minutes used today, read by admitting none. */
const usedToday = (namespace: typeof sampleNamespace) =>
  NamespaceUsage.use((usage) =>
    usage.admit(namespace, "container-minutes", 0, `read:${crypto.randomUUID()}`),
  ).pipe(Effect.map(({ limit, remaining }) => limit - remaining));

/** 2 Oct 2026 10:00 UTC, and that day's UTC midnight after it. */
const MORNING = Date.UTC(2026, 9, 2, 10);
const MIDNIGHT = Date.UTC(2026, 9, 3);

const world = (quotas = {}) => {
  const usage = makeNamespaceUsageMemory({ quotas });
  usage.clock.advance(MORNING - usage.clock.now());
  return Layer.mergeAll(usage.layer, makeIdsMemory().layer);
};

describe("a verification's container-minutes", () => {
  it("[budget.plan-minutes] a plan is admitted one attempt of each Tier 2 step's deadline, each rounded up to the minute; a step no runner takes, or outside Tier 2, counts nothing", () => {
    const [suite, typecheck] = STEPS;
    if (suite === undefined || typecheck === undefined) throw new Error("the plan has two steps");
    expect(STEPS.map((step) => step.tier.tier)).toEqual([2, 2]);
    expect(planMinutes(STEPS, () => 300_000)).toBe(10);
    expect(planMinutes(STEPS, () => 61_000)).toBe(4);
    expect(planMinutes(STEPS, (step) => (step.id === suite.id ? 300_000 : undefined))).toBe(5);
    const lowered = { ...typecheck, tier: { tier: 1 as const, reason: "the test's" } };
    expect(planMinutes([suite, lowered], () => 300_000)).toBe(5);
    expect(planMinutes([], () => 300_000)).toBe(0);
  });

  it("[budget.used-minutes] a verification used what its Tier 2 reports took, together, rounded up; a report outside Tier 2 or below zero counts nothing", () => {
    const [suite, typecheck] = STEPS;
    if (suite === undefined || typecheck === undefined) throw new Error("the plan has two steps");
    expect(usedMinutes([report(suite, 30_000), report(typecheck, 45_000)])).toBe(2);
    expect(usedMinutes([report(suite, 60_000), report(typecheck, 60_000)])).toBe(2);
    expect(
      usedMinutes([report(suite, 1), report(typecheck, 600_000, { tier: 1, reason: "t" })]),
    ).toBe(1);
    expect(usedMinutes([report(suite, -120_000), report(typecheck, 30_000)])).toBe(1);
    expect(usedMinutes([])).toBe(0);
  });

  it.effect(
    "[budget.admit-settle] a verification is admitted its minutes once under its instance, then settled once to what it used; one past the day's limit is refused and counts nothing",
    () =>
      Effect.gen(function* () {
        const [suite, typecheck] = STEPS;
        if (suite === undefined || typecheck === undefined) throw new Error("two steps");
        expect(yield* admitVerification(sampleNamespace, "wf-1", 10)).toEqual({
          _tag: "Admitted",
          minutes: 10,
        });
        // A replayed step counts nothing again.
        yield* admitVerification(sampleNamespace, "wf-1", 10);
        expect(yield* usedToday(sampleNamespace)).toBe(10);
        // It used two minutes of the ten: eight are given back, once.
        const reports = [report(suite, 30_000), report(typecheck, 45_000)];
        yield* settleMinutes(sampleNamespace, "wf-1", 10, reports);
        yield* settleMinutes(sampleNamespace, "wf-1", 10, reports);
        expect(yield* usedToday(sampleNamespace)).toBe(2);
        // One that ran past what it was admitted is counted the difference.
        yield* admitVerification(sampleNamespace, "wf-2", 1);
        yield* settleMinutes(sampleNamespace, "wf-2", 1, reports);
        expect(yield* usedToday(sampleNamespace)).toBe(4);
        // At the limit of 20: 16 more fit, 17 do not, and the refusal counts nothing.
        expect(yield* admitVerification(sampleNamespace, "wf-3", 17)).toMatchObject({
          _tag: "Refused",
          exceeded: { kind: "container-minutes", reason: "limit", used: 4, requested: 17 },
        });
        expect(yield* usedToday(sampleNamespace)).toBe(4);
        expect(yield* admitVerification(sampleNamespace, "wf-4", 16)).toMatchObject({
          _tag: "Admitted",
        });
        // Another namespace's count is its own.
        expect(yield* usedToday(otherNamespace)).toBe(0);
      }).pipe(Effect.provide(world({ defaults: { "container-minutes": 20 } }))),
  );

  it.effect("[budget.halted] a halted namespace is refused even a plan of no minutes", () =>
    Effect.gen(function* () {
      expect(yield* admitVerification(sampleNamespace, "wf-h", 0)).toMatchObject({
        _tag: "Refused",
        exceeded: { reason: "halted" },
      });
      expect(yield* admitVerification(otherNamespace, "wf-o", 0)).toEqual({
        _tag: "Admitted",
        minutes: 0,
      });
    }).pipe(Effect.provide(world({ halted: [sampleNamespace] }))),
  );

  it.effect(
    "[budget.refused-verdict] past the limit the verdict parks unrun until UTC midnight, saying what was used; halted, it bounces through no fault of the change's, with what its owner does",
    () =>
      Effect.gen(function* () {
        const over = yield* admitVerification(sampleNamespace, "wf-over", 30);
        if (over._tag !== "Refused") throw new Error("30 of 20 is refused");
        const parked = yield* settleRefused(sampleNamespace, PLAN_HASH, over.exceeded);
        expect(parked).toMatchObject({
          outcome: "park",
          unrun: true,
          retryAt: MIDNIGHT,
          planHash: PLAN_HASH,
          failingTests: [],
        });
        expect(parked.halted).toBeUndefined();
        expect(parked.evidence).toEqual([
          `quota.exceeded: ${sampleNamespace} has used 0 of its 20 container-minutes for today, and this verification needs 30; nothing ran`,
        ]);
        expect(parked.nextActions).toEqual([expect.objectContaining({ kind: "wait" })]);
        const halted = yield* Effect.provide(
          admitVerification(sampleNamespace, "wf-halted", 1),
          makeNamespaceUsageMemory({ quotas: { halted: [sampleNamespace] } }).layer,
        );
        if (halted._tag !== "Refused") throw new Error("halted is refused");
        const bounced = yield* settleRefused(sampleNamespace, PLAN_HASH, halted.exceeded);
        expect(bounced).toMatchObject({ outcome: "bounce", halted: true, failingTests: [] });
        expect(bounced.unrun).toBeUndefined();
        expect(bounced.retryAt).toBeUndefined();
        expect(bounced.evidence).toEqual([
          `namespace.halted: verification spend is stopped for ${sampleNamespace}; the change itself passed nothing and failed nothing`,
        ]);
        expect(bounced.nextActions).toEqual([
          {
            kind: "escalate",
            title: `Verification spend is stopped for ${sampleNamespace}: ask whoever runs this Keel to resume it`,
          },
          {
            kind: "call",
            title: "Submit the change again once its namespace's verification is resumed",
            operationId: "submit",
          },
        ]);
        expect(parked.verdictId).not.toBe(bounced.verdictId);
      }).pipe(Effect.provide(world({ defaults: { "container-minutes": 20 } }))),
  );
});
