import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { SubjectKey } from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  contentHashOf,
  type Json,
  type PredicatePolicy,
  weakest,
} from "../../../src/domain/kernel/index.ts";
import {
  compile,
  type Flow,
  type FlowPlan,
  planHashOf,
  unionPlans,
} from "../../../src/domain/verification/index.ts";
import {
  base,
  emptyDefaults,
  factClasses,
  guardedCaseArb,
  otherCommit,
  policyArb,
} from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";

const changeArb = fc.record({
  touched: fc.subarray(
    ["src/authz/check.ts", "src/billing/charge.ts", "docs/readme.md", ".keel/flow.ts"],
    { minLength: 1 },
  ),
  subjects: fc.subarray(["authz", "billing.cache"]),
  policy: fc.record(
    { freshness: policyArb, authority: policyArb, ordering: policyArb },
    { requiredKeys: [] },
  ),
  other: fc.boolean(),
});

/**
 * A batch: one project's flow spec, compiled for one to four changes, each
 * with its own paths, subjects, predicate policy and base commit. Their plans
 * prune and cite differently but share step versions, as a batch's do.
 */
const batchArb: fc.Arbitrary<readonly [FlowPlan, ...FlowPlan[]]> = guardedCaseArb().chain((c) =>
  fc.array(changeArb, { minLength: 1, maxLength: 4 }).map((changes) => {
    const [first, ...rest] = changes.map((ch) => {
      const commit = ch.other ? otherCommit : base;
      return Result.getOrThrow(
        compile(
          { ...c.spec, commit },
          {
            baseCommit: commit,
            touchedPaths: ch.touched,
            subjects: ch.subjects.map((s) => SubjectKey.make(s)),
            facts: factClasses,
            predicatePolicy: ch.policy,
          },
          emptyDefaults,
        ),
      );
    });
    if (first === undefined) throw new Error("a batch has a member");
    return [first, ...rest] as const;
  }),
);

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const same = (a: FlowPlan, b: FlowPlan): boolean =>
  canonicalJson(asJson(a)) === canonicalJson(asJson(b));
const unionOf = (plans: readonly [FlowPlan, ...FlowPlan[]]): FlowPlan =>
  Result.getOrThrow(unionPlans(plans));
const distinct = (plans: readonly FlowPlan[]): readonly FlowPlan[] => [
  ...new Map(plans.map((p) => [p.planHash, p] as const)).values(),
];

const stepsIn = (flow: Flow): readonly string[] => {
  switch (flow._tag) {
    case "step":
      return [flow.step];
    case "seq":
    case "par":
    case "cascade":
      return flow.items.flatMap(stepsIn);
    default:
      return stepsIn(flow.body);
  }
};

const STRICTNESS: Readonly<Record<PredicatePolicy, number>> = { annotate: 0, advise: 1, block: 2 };

describe("unionPlans: the plan a batch runs", () => {
  it("[union.singleton] a batch of one runs its member's plan unchanged, hash and all", () => {
    fc.assert(
      fc.property(batchArb, (plans) =>
        plans.every((p) => {
          const u = unionOf([p]);
          return u.planHash === p.planHash && same(u, p);
        }),
      ),
    );
    const [p] = fc.sample(batchArb, { numRuns: 1, seed: 42 })[0] ?? [];
    expect(p === undefined ? undefined : unionOf([p, p])).toBe(p);
  });

  it("[union.idempotent] a member listed twice changes nothing", () => {
    fc.assert(
      fc.property(batchArb, (plans) => same(unionOf([...plans, ...plans]), unionOf(plans))),
    );
    const plans = fc.sample(batchArb, { numRuns: 1, seed: 7 })[0];
    expect(plans === undefined ? 0 : unionOf([...plans, ...plans]).costEstimate).toBe(
      plans === undefined ? 0 : unionOf(plans).costEstimate,
    );
  });

  it("[union.commutative] the order of the members never matters", () => {
    let reordered = 0;
    fc.assert(
      fc.property(
        batchArb.chain((plans) =>
          fc
            .shuffledSubarray([...plans], { minLength: plans.length, maxLength: plans.length })
            .map((shuffled) => ({ plans, shuffled })),
        ),
        ({ plans, shuffled }) => {
          const [first, ...rest] = shuffled;
          if (first === undefined) return false;
          if (distinct(plans).length > 1 && shuffled.some((p, i) => p !== plans[i])) reordered++;
          const u = unionOf(plans);
          return same(u, unionOf([first, ...rest])) && planHashOf(u) === u.planHash;
        },
      ),
    );
    expect(reordered).toBeGreaterThan(0);
  });

  it("[union.plan-fields] the union names its members by hash, is human-class if any member is, costs their sum, and takes the least base commit", () => {
    let unions = 0;
    fc.assert(
      fc.property(batchArb, (plans) => {
        const members = distinct(plans);
        if (members.length < 2) return true;
        unions++;
        const u = unionOf(plans);
        const sorted = members.toSorted((a, b) => (a.planHash < b.planHash ? -1 : 1));
        return (
          u.members?.join() === sorted.map((m) => m.planHash).join() &&
          u.humanClass === members.some((m) => m.humanClass) &&
          // Summed in planHash order, so floating point never depends on the argument order.
          u.costEstimate === sorted.reduce((sum, m) => sum + m.costEstimate, 0) &&
          u.baseCommit === members.map((m) => m.baseCommit).toSorted()[0] &&
          u.flow._tag === "par" &&
          u.flow.items.length === members.length
        );
      }),
    );
    expect(unions).toBeGreaterThan(0);
  });

  it("[union.keeps-steps] every member's step is in the union, at a tier, class, worlds and policy at least as strict", () => {
    let laterOnly = 0;
    fc.assert(
      fc.property(batchArb, (plans) => {
        const u = unionOf(plans);
        const steps = new Map(u.steps.map((s) => [s.id, s]));
        const [least] = distinct(plans).toSorted((a, b) => (a.planHash < b.planHash ? -1 : 1));
        return plans.every((m) =>
          m.steps.every((s) => {
            if (least !== undefined && !least.steps.some((x) => x.id === s.id)) laterOnly++;
            const k = steps.get(s.id);
            if (k === undefined) return false;
            const kClass = k.effectiveClass ?? k.evidenceCeiling;
            return (
              k.tier.tier >= s.tier.tier &&
              weakest(kClass, s.effectiveClass ?? s.evidenceCeiling) === kClass &&
              weakest(k.evidenceCeiling, s.evidenceCeiling) === k.evidenceCeiling &&
              (s.worlds ?? []).every((w) => k.worlds?.includes(w) === true) &&
              (s.guards === undefined ||
                (k.guards !== undefined &&
                  STRICTNESS[k.guards.policy] >= STRICTNESS[s.guards.policy])) &&
              (k.optional !== true || s.optional === true)
            );
          }),
        );
      }),
    );
    expect(laterOnly).toBeGreaterThan(0);
  });

  it("[union.step-once] a step two members share is planned once, though both branches name it: it runs once per plan run and every branch reads that result", () => {
    let shared = 0;
    fc.assert(
      fc.property(batchArb, (plans) => {
        const u = unionOf(plans);
        const ids = u.steps.map((s) => s.id);
        if (new Set(ids).size !== ids.length) return false;
        if (u.flow._tag !== "par" || distinct(plans).length < 2) return true;
        const branches = u.flow.items.map((f) => new Set(stepsIn(f)));
        return ids.every((id) => {
          const holders = distinct(plans).filter((m) => m.steps.some((s) => s.id === id)).length;
          if (holders < 2) return true;
          shared++;
          return branches.filter((b) => b.has(id)).length >= 2;
        });
      }),
    );
    expect(shared).toBeGreaterThan(0);
  });

  it("[union.version-conflict] members that plan a step at different versions, or come from different compilers, cannot share a run", () => {
    let conflicts = 0;
    fc.assert(
      fc.property(batchArb, (plans) => {
        const [p] = plans;
        const step = p.steps[0];
        if (step === undefined) return true;
        conflicts++;
        const bumped = {
          ...p,
          versions: { ...p.versions, [step.id]: contentHashOf({ bumped: step.id }) },
        };
        const other = { ...bumped, planHash: planHashOf(bumped) };
        const older = { ...p, compiler: "flow-compiler/1" };
        const recompiled = { ...older, planHash: planHashOf(older) };
        const byVersion = unionPlans([p, other]);
        const byCompiler = unionPlans([p, recompiled]);
        return (
          Result.isFailure(byVersion) &&
          byVersion.failure.stepId === step.id &&
          Result.isFailure(byCompiler) &&
          byCompiler.failure.stepId === undefined
        );
      }),
    );
    expect(conflicts).toBeGreaterThan(0);
  });

  it("[union.guard-probe-conflict] members whose guard step pins different probes cannot share a run; pinning the same one, the union keeps it", () => {
    let guarded = 0;
    fc.assert(
      fc.property(batchArb, (plans) => {
        const [p] = plans;
        const step = p.steps.find((s) => s.guards !== undefined);
        if (step?.guards === undefined) return true;
        guarded++;
        const probe = step.guards.probe;
        const other = contentHashOf({ other: probe });
        const repinned = {
          ...p,
          steps: p.steps.map((s) =>
            s.id === step.id && s.guards !== undefined
              ? { ...s, guards: { ...s.guards, probe: other } }
              : s,
          ),
        };
        const rival = { ...repinned, planHash: planHashOf(repinned) };
        const clash = unionPlans([p, rival]);
        const kept = unionOf(plans).steps.find((s) => s.id === step.id)?.guards?.probe;
        return (
          Result.isFailure(clash) &&
          clash.failure.stepId === step.id &&
          [...clash.failure.versions].toSorted().join() === [probe, other].toSorted().join() &&
          kept === probe
        );
      }),
    );
    expect(guarded).toBeGreaterThan(0);
  });
});
