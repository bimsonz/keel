import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { readStoredPlan, storedPlanText } from "../../../src/application/verification/index.ts";
import { compile, type FlowPlan, unionPlans } from "../../../src/domain/verification/index.ts";
import {
  emptyDefaults,
  type FlowCase,
  guardedCaseArb,
  ruledCaseArb,
} from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";

const planOf = (c: FlowCase): FlowPlan =>
  Result.getOrThrow(compile(c.spec, c.facts, emptyDefaults));

/** Any compiled plan, guards and the human class included, or a union of two. */
const planArb: fc.Arbitrary<FlowPlan> = fc.oneof(
  guardedCaseArb().map(planOf),
  fc
    .tuple(guardedCaseArb(), guardedCaseArb())
    .map(([a, b]) => unionPlans([planOf(a), planOf(b)]))
    .filter(Result.isSuccess)
    .map((r) => r.success),
);

type Stored = Record<string, unknown>;

/** One edit at rest to a field the plan's hash covers. */
const edits: readonly ((stored: Stored) => Stored)[] = [
  (s) => ({ ...s, humanClass: s["humanClass"] !== true }),
  (s) => ({ ...s, baseCommit: "c".repeat(40) }),
  (s) => ({ ...s, compiler: "flow-compiler/0" }),
  (s) => ({ ...s, steps: [] }),
  (s) => ({ ...s, flow: { _tag: "par", items: [] } }),
  (s) => ({ ...s, versions: {} }),
  (s) => ({ ...s, overrides: { extra: ["x"] } }),
  (s) => ({ ...s, mayskip: { extra: ["x"] } }),
  (s) => ({ ...s, members: [`sha256:${"d".repeat(64)}`] }),
];

describe("a plan as the plan store keeps it", () => {
  it("[plan-codec.round-trip] reads back every compiled plan, unions too, exactly as it was compiled", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const text = Result.getOrThrow(storedPlanText(plan));
        expect(Result.getOrThrow(readStoredPlan(plan.planHash, text))).toEqual(plan);
      }),
    );
  });

  it("[plan-codec.any-edit-refused] refuses a plan with any field its hash covers edited at rest", () => {
    fc.assert(
      fc.property(planArb, fc.constantFrom(...edits), (plan, edit) => {
        const text = Result.getOrThrow(storedPlanText(plan));
        const edited = JSON.stringify(edit(JSON.parse(text)));
        // An edit that leaves the field as it was is no edit.
        fc.pre(edited !== text);
        expect(Result.isFailure(readStoredPlan(plan.planHash, edited))).toBe(true);
      }),
    );
  });

  it("keeps the cost estimate beside the hash: it is advisory, so an edited one still reads", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const stored: Stored = JSON.parse(Result.getOrThrow(storedPlanText(plan)));
        const read = readStoredPlan(
          plan.planHash,
          JSON.stringify({ ...stored, costEstimate: 1e9 }),
        );
        expect(Result.getOrThrow(read).costEstimate).toBe(1e9);
      }),
    );
  });

  it("refuses to store a plan whose own hash lies", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        expect(Result.isFailure(storedPlanText({ ...plan, humanClass: !plan.humanClass }))).toBe(
          true,
        );
      }),
    );
  });

  it("[plan-codec.ruled] reads back a plan whose guards hold decisions exactly as it was compiled", () => {
    let ruled = 0;
    assertReaching(
      fc.property(ruledCaseArb().map(planOf), (plan) => {
        if (plan.steps.some((s) => s.guards?.decision !== undefined)) ruled++;
        const text = Result.getOrThrow(storedPlanText(plan));
        expect(Result.getOrThrow(readStoredPlan(plan.planHash, text))).toEqual(plan);
      }),
    );
    expect(ruled).toBeGreaterThan(0);
  });
});
