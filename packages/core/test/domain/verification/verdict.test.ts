import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { canBlock, contentHashOf, makeId } from "../../../src/domain/kernel/index.ts";
import {
  coerce,
  compile,
  type FlowPlan,
  type InfraFailure,
  type PlanStep,
  type Run,
  type StepReport,
  type StepResult,
  type StepSpec,
  verdict,
  type VerdictOutcome,
  type FlowWorld,
} from "../../../src/domain/verification/index.ts";
import { base, emptyDefaults, factClasses, flowCaseArb } from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";
import { SubjectKey } from "../../../src/domain/coordination/index.ts";

const failures: readonly InfraFailure[] = [
  "timeout",
  "rate-limited",
  "schema",
  "truncated",
  "unavailable",
];

type Cell = { readonly step: PlanStep; readonly world: FlowWorld | undefined };
const cells = (plan: FlowPlan): readonly Cell[] =>
  plan.steps.flatMap((step) => (step.worlds ?? [undefined]).map((world) => ({ step, world })));

const report = (cell: Cell, outcome: string, extra: Partial<StepReport> = {}): StepReport => ({
  stepId: cell.step.id,
  outcome,
  evidenceClass: cell.step.effectiveClass ?? cell.step.evidenceCeiling,
  tier: cell.step.tier,
  durationMs: 1,
  ...(cell.world === undefined ? {} : { world: cell.world }),
  ...extra,
});

type Choice =
  | { readonly kind: "missing" }
  | { readonly kind: "outcome"; readonly pick: number }
  | { readonly kind: "infra"; readonly pick: number };
const choiceArb: fc.Arbitrary<Choice> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ kind: "missing" as const }) },
  { weight: 6, arbitrary: fc.nat().map((pick) => ({ kind: "outcome" as const, pick })) },
  { weight: 1, arbitrary: fc.nat().map((pick) => ({ kind: "infra" as const, pick })) },
);

/** A compiled plan and coerced results for some of its cells: declared outcomes, infra failures, or nothing yet. */
const runArb = flowCaseArb().chain((c) => {
  const plan = Result.getOrThrow(compile(c.spec, c.facts, emptyDefaults));
  const all = cells(plan);
  return fc
    .record({
      choices: fc.tuple(...all.map(() => choiceArb)),
      overridePicks: fc.tuple(...all.map(() => fc.boolean())),
    })
    .map(({ choices, overridePicks }) => {
      const results = all.flatMap((cell, i): StepResult[] => {
        const choice = choices[i] ?? { kind: "missing" };
        if (choice.kind === "missing") return [];
        const outcomes = cell.step.outcomes ?? ["abstain"];
        const overrides =
          cell.step.kind === "human" && overridePicks[i] === true
            ? [...(plan.overrides[cell.step.id] ?? [])]
            : [];
        const r =
          choice.kind === "infra"
            ? report(cell, outcomes[choice.pick % outcomes.length] ?? "abstain", {
                failure: failures[choice.pick % failures.length] ?? "timeout",
              })
            : report(
                cell,
                outcomes[choice.pick % outcomes.length] ?? "abstain",
                overrides.length > 0 ? { overrides } : {},
              );
        return [coerce(plan, r)];
      });
      return { plan, results };
    });
});

const decide = (plan: FlowPlan, run: Run): VerdictOutcome =>
  Result.getOrThrow(verdict(plan, run, "verdict/1")).outcome;
const strictness = (o: VerdictOutcome): number =>
  ({ land: 0, hold: 1, park: 2, bounce: 2, supersede: 3 })[o];

const routeOnly = (plan: FlowPlan, r: StepResult): boolean => {
  const step = plan.steps.find((s) => s.id === r.stepId);
  return step !== undefined && !canBlock(step.effectiveClass ?? step.evidenceCeiling);
};

/** A plan of required proof steps in one seq, with no when, cascade or optional step to soften it. */
const plainPlan = (n: number): FlowPlan => {
  const steps: StepSpec[] = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    version: contentHashOf({ i }),
    kind: "deterministic",
    evidenceCeiling: "proof",
    appliesTo: { paths: [], subjects: [] },
    reads: [],
    outcomes: ["pass", "fail", "escalate", "abstain"],
    mayskip: [],
    overrides: [],
    budget: { usd: 0, cpuMs: 1, tokens: 0 },
    determinism: "deterministic",
    suite: true,
    optional: false,
  }));
  const flow = {
    _tag: "seq" as const,
    exitOn: "fail" as const,
    items: steps.map((s) => ({ _tag: "step" as const, step: s.id })),
  };
  return Result.getOrThrow(
    compile(
      { commit: base, flow, steps },
      {
        baseCommit: base,
        touchedPaths: ["src/a.ts"],
        subjects: [SubjectKey.make("authz")],
        facts: factClasses,
      },
      emptyDefaults,
    ),
  );
};

const plainRunArb = fc.integer({ min: 1, max: 5 }).chain((n) => {
  const plan = plainPlan(n);
  return fc
    .tuple(
      ...plan.steps.map(() =>
        fc.oneof(
          fc.constantFrom("pass", "fail", "escalate", "abstain", "missing"),
          fc.constantFrom(...failures).map((f) => ({ f })),
        ),
      ),
    )
    .map((picks) => ({
      plan,
      picks,
      results: plan.steps.flatMap((step, i): StepResult[] => {
        const p = picks[i];
        if (p === undefined || p === "missing") return [];
        const cell = { step, world: undefined };
        return [
          coerce(
            plan,
            typeof p === "string" ? report(cell, p) : report(cell, "pass", { failure: p.f }),
          ),
        ];
      }),
    }));
});

const specStep = (id: string, extra: Partial<StepSpec> = {}): StepSpec => ({
  id,
  version: contentHashOf({ id }),
  kind: "deterministic",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0, cpuMs: 1, tokens: 0 },
  determinism: "deterministic",
  suite: false,
  optional: false,
  ...extra,
});
const facts = { baseCommit: base, touchedPaths: ["src/a.ts"], subjects: [], facts: factClasses };
const build = (steps: StepSpec[], flow: FlowPlan["flow"]): FlowPlan =>
  Result.getOrThrow(compile({ commit: base, steps, flow }, facts, emptyDefaults));
const res = (plan: FlowPlan, id: string, outcome: string, world?: FlowWorld): StepResult => {
  const s = plan.steps.find((x) => x.id === id)!;
  return coerce(plan, report({ step: s, world }, outcome));
};

describe("verdict", () => {
  it("[verdict.bounce-only-on-proof-or-ruling] a bounce rests only on unoverridden fails from proof or a ruling", () => {
    let bounces = 0;
    fc.assert(
      fc.property(runArb, ({ plan, results }) => {
        const v = Result.getOrThrow(verdict(plan, { results }, "verdict/1"));
        if (v.outcome !== "bounce") return true;
        bounces++;
        return (
          v.evidence.length > 0 &&
          v.evidence.every((r) => r.outcome === "fail" && canBlock(r.evidenceClass))
        );
      }),
    );
    expect(bounces).toBeGreaterThan(0);
  });

  it("[verdict.opinion-monotone] opinion only adds scrutiny: a run is never less strict than the same run with every opinion merely annotating", () => {
    fc.assert(
      fc.property(runArb, ({ plan, results }) => {
        const neutral = results.map((r): StepResult =>
          routeOnly(plan, r) ? { ...r, outcome: "annotate" } : r,
        );
        return (
          strictness(decide(plan, { results })) >= strictness(decide(plan, { results: neutral }))
        );
      }),
    );
    const plan = build(
      [
        specStep("tests"),
        specStep("clef", {
          kind: "decision-model",
          evidenceCeiling: "opinion",
          outcomes: ["escalate", "annotate", "abstain"],
        }),
      ],
      {
        _tag: "seq",
        exitOn: "fail",
        items: [
          { _tag: "step", step: "tests" },
          { _tag: "step", step: "clef" },
        ],
      },
    );
    expect(
      decide(plan, { results: [res(plan, "tests", "pass"), res(plan, "clef", "escalate")] }),
    ).toBe("park");
    expect(
      decide(plan, { results: [res(plan, "tests", "pass"), res(plan, "clef", "annotate")] }),
    ).toBe("land");
    expect(
      decide(plan, { results: [res(plan, "tests", "fail"), res(plan, "clef", "annotate")] }),
    ).toBe("bounce");
  });

  it("[verdict.only-human-overrides-fail] an override counts only from a human step", () => {
    fc.assert(
      fc.property(runArb, ({ plan, results }) => {
        const failed = results.filter((r) => r.outcome === "fail").map((r) => r.stepId);
        const forged = results.map((r): StepResult =>
          plan.steps.find((s) => s.id === r.stepId)?.kind === "human"
            ? r
            : { ...r, overrides: failed },
        );
        return decide(plan, { results: forged }) === decide(plan, { results });
      }),
    );
    const plan = plainPlan(1);
    const fail = coerce(plan, report({ step: plan.steps[0]!, world: undefined }, "fail"));
    expect(decide(plan, { results: [fail] })).toBe("bounce");
  });

  it("[verdict.infra-failure-never-lands] a timeout, rate limit, schema failure or truncation on a required step abstains and never lands", () => {
    fc.assert(
      fc.property(plainRunArb, ({ plan, picks, results }) => {
        const hadInfra = picks.some((p) => typeof p === "object");
        return !hadInfra || decide(plan, { results }) !== "land";
      }),
    );
    const plan = plainPlan(1);
    const cell = { step: plan.steps[0]!, world: undefined };
    for (const failure of failures)
      expect(coerce(plan, report(cell, "pass", { failure })).outcome).toBe("abstain");
    expect(coerce(plan, report(cell, "skip-everything")).outcome).toBe("abstain");
    expect(coerce(plan, report(cell, "pass", { evidenceClass: "opinion" })).outcome).toBe(
      "abstain",
    );
  });

  it("[verdict.land-is-complete] a land means every required step passed", () => {
    fc.assert(
      fc.property(plainRunArb, ({ plan, results }) => {
        const landed = decide(plan, { results }) === "land";
        const complete = plan.steps.every((s) =>
          results.some((r) => r.stepId === s.id && r.outcome === "pass"),
        );
        return landed === complete;
      }),
    );
    const plan = plainPlan(2);
    const first = coerce(plan, report({ step: plan.steps[0]!, world: undefined }, "pass"));
    expect(decide(plan, { results: [first] })).toBe("hold");
  });

  it("[verdict.escalation-parks] with no deciding fail, an escalation or an abstain on a required step parks for a ruling", () => {
    fc.assert(
      fc.property(plainRunArb, ({ plan, results }) => {
        const outcome = decide(plan, { results });
        const firstFail = plan.steps.findIndex((s) =>
          results.some((r) => r.stepId === s.id && r.outcome === "fail"),
        );
        const before = firstFail === -1 ? plan.steps : plan.steps.slice(0, firstFail);
        const escalates = before.some((s) =>
          results.some(
            (r) => r.stepId === s.id && (r.outcome === "escalate" || r.outcome === "abstain"),
          ),
        );
        if (firstFail !== -1) return outcome === "bounce";
        return !escalates || outcome === "park";
      }),
    );
    const plan = plainPlan(2);
    const [a, b] = plan.steps;
    const results = [
      coerce(plan, report({ step: a!, world: undefined }, "pass")),
      coerce(plan, report({ step: b!, world: undefined }, "abstain")),
    ];
    expect(decide(plan, { results })).toBe("park");
  });

  it("[verdict.order-independent] the order results arrive in never changes the verdict", () => {
    fc.assert(
      fc.property(runArb, fc.nat(), ({ plan, results }, seed) => {
        const shuffled = results
          .map((r, i) => [r, (i * 7919 + seed) % 104729] as const)
          .toSorted((a, b) => a[1] - b[1])
          .map(([r]) => r);
        expect(verdict(plan, { results: shuffled }, "verdict/1")).toEqual(
          verdict(plan, { results }, "verdict/1"),
        );
      }),
    );
    // A condition outside the worlds node reads a step that ran in several worlds.
    const matrix = build(
      [
        specStep("probe", { worlds: ["A", "AB"], outcomes: ["pass", "annotate", "abstain"] }),
        specStep("deep"),
      ],
      {
        _tag: "seq",
        exitOn: "fail",
        items: [
          { _tag: "worlds", over: ["A", "AB"], body: { _tag: "step", step: "probe" } },
          {
            _tag: "when",
            condition: { _tag: "outcome", step: "probe", in: ["annotate"] },
            body: { _tag: "step", step: "deep" },
          },
        ],
      },
    );
    const inA = res(matrix, "probe", "pass", "A");
    const inAB = res(matrix, "probe", "annotate", "AB");
    expect(decide(matrix, { results: [inA, inAB] })).toBe(decide(matrix, { results: [inAB, inA] }));
  });

  it("[verdict.versioned] the verdict is a versioned function, stamped with its version and plan, and superseding wins", () => {
    const plan = plainPlan(2);
    const passes = plan.steps.map((step) =>
      coerce(plan, report({ step, world: undefined }, "pass")),
    );
    const v = Result.getOrThrow(verdict(plan, { results: passes }, "verdict/1"));
    expect([v.outcome, v.version, v.planHash]).toEqual(["land", "verdict/1", plan.planHash]);
    expect(Result.isFailure(verdict(plan, { results: passes }, "verdict/0"))).toBe(true);
    expect(
      decide(plan, { results: passes, supersededBy: makeId("chg", "0".repeat(25) + "9") }),
    ).toBe("supersede");
  });

  it("[verdict.flow-semantics] cascades stop at the first accepted outcome, when skips its body, worlds need every world", () => {
    const cascade = build([specStep("fast"), specStep("slow")], {
      _tag: "cascade",
      accept: ["pass"],
      items: [
        { _tag: "step", step: "fast" },
        { _tag: "step", step: "slow" },
      ],
    });
    expect(decide(cascade, { results: [res(cascade, "fast", "pass")] })).toBe("land");
    expect(
      decide(cascade, { results: [res(cascade, "fast", "abstain"), res(cascade, "slow", "pass")] }),
    ).toBe("land");
    expect(
      decide(cascade, {
        results: [res(cascade, "fast", "abstain"), res(cascade, "slow", "abstain")],
      }),
    ).toBe("park");

    const when = build([specStep("gate"), specStep("deep")], {
      _tag: "seq",
      exitOn: "fail",
      items: [
        { _tag: "step", step: "gate" },
        {
          _tag: "when",
          condition: { _tag: "outcome", step: "gate", in: ["fail"] },
          body: { _tag: "step", step: "deep" },
        },
      ],
    });
    expect(decide(when, { results: [res(when, "gate", "pass")] })).toBe("land");

    const matrix = build([specStep("probe", { worlds: ["trunk", "A", "AB"] })], {
      _tag: "worlds",
      over: ["trunk", "A", "AB"],
      body: { _tag: "step", step: "probe" },
    });
    const some = [res(matrix, "probe", "pass", "trunk"), res(matrix, "probe", "pass", "A")];
    expect(decide(matrix, { results: some })).toBe("hold");
    expect(decide(matrix, { results: [...some, res(matrix, "probe", "fail", "AB")] })).toBe(
      "bounce",
    );
  });
});
