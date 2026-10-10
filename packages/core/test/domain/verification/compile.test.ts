import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { SubjectKey } from "../../../src/domain/coordination/index.ts";
import {
  contentHashOf,
  type EvidenceClass,
  Glob,
  matchesGlob,
  weakest,
} from "../../../src/domain/kernel/index.ts";
import {
  type CompileError,
  compile,
  type Condition,
  defaultFlowPolicy,
  type FlowDefinition,
  type FlowPlan,
  HUMAN_CLASS_STEP,
  type StepSpec,
} from "../../../src/domain/verification/index.ts";
import {
  base,
  emptyDefaults,
  type FlowCase,
  factClasses,
  flowCaseArb,
  otherCommit,
} from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";

const ok = (c: FlowCase): FlowPlan => Result.getOrThrow(compile(c.spec, c.facts, emptyDefaults));
const errorsOf = (c: FlowCase): readonly CompileError[] => {
  const r = compile(c.spec, c.facts, emptyDefaults);
  return Result.isFailure(r) ? r.failure : [];
};
const tags = (c: FlowCase): readonly string[] => errorsOf(c).map((e) => e._tag);

/** Replaces one step of the spec. */
const withStep = (c: FlowCase, index: number, change: (s: StepSpec) => StepSpec): FlowCase => ({
  ...c,
  spec: {
    ...c.spec,
    steps: c.spec.steps.map((s, i) => (i === index % c.spec.steps.length ? change(s) : s)),
  },
});

/** Effective classes, recomputed from the spec by walking every read path. */
const oracleEffective = (spec: FlowDefinition): ReadonlyMap<string, EvidenceClass> => {
  const byId = new Map(spec.steps.map((s) => [s.id, s]));
  const out = new Map<string, EvidenceClass>();
  const visit = (id: string): EvidenceClass => {
    const s = byId.get(id);
    if (s === undefined) return "opinion";
    if (s.kind === "human") return "ruling";
    let cls = s.evidenceCeiling;
    for (const r of s.reads)
      cls = weakest(cls, r._tag === "fact" ? (factClasses[r.fact] ?? "opinion") : visit(r.step));
    return cls;
  };
  for (const s of spec.steps) out.set(s.id, visit(s.id));
  return out;
};

const opinionStep = (id: string, outcomes: StepSpec["outcomes"]): StepSpec => ({
  id,
  version: contentHashOf({ id }),
  kind: "decision-model",
  evidenceCeiling: "opinion",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes,
  mayskip: [],
  overrides: [],
  budget: { usd: 0.002, cpuMs: 10, tokens: 1000 },
  determinism: "nondeterministic",
  suite: false,
  optional: false,
});
const suiteStep = (id: string, extra: Partial<StepSpec> = {}): StepSpec => ({
  ...opinionStep(id, ["pass", "fail", "abstain"]),
  kind: "deterministic",
  evidenceCeiling: "proof",
  determinism: "deterministic",
  suite: true,
  ...extra,
});
const whenOn = (condition: Condition, first = "clef"): FlowDefinition["flow"] => ({
  _tag: "seq",
  exitOn: "fail",
  items: [
    { _tag: "step", step: first },
    { _tag: "when", condition, body: { _tag: "step", step: "deep" } },
  ],
});
/** The same step with its keys in reverse insertion order. */
const reverseKeys = (s: StepSpec): StepSpec => {
  const {
    optional,
    tier,
    suite,
    determinism,
    budget,
    worlds,
    overrides,
    mayskip,
    outcomes,
    reads,
    appliesTo,
    evidenceCeiling,
    kind,
    version,
    id,
  } = s;
  return {
    optional,
    ...(tier === undefined ? {} : { tier }),
    suite,
    determinism,
    budget,
    ...(worlds === undefined ? {} : { worlds }),
    overrides,
    mayskip,
    outcomes,
    reads,
    appliesTo,
    evidenceCeiling,
    kind,
    version,
    id,
  };
};
const single = (steps: readonly StepSpec[], flow?: FlowDefinition["flow"]): FlowCase => ({
  spec: {
    commit: base,
    steps,
    flow: flow ?? {
      _tag: "seq",
      exitOn: "fail",
      items: steps.map((s) => ({ _tag: "step", step: s.id })),
    },
  },
  facts: {
    baseCommit: base,
    touchedPaths: ["src/authz/check.ts"],
    subjects: [SubjectKey.make("authz")],
    facts: factClasses,
  },
});

describe("flow compiler: typing rules", () => {
  it("[flow.well-typed-compiles] a well-typed spec compiles", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => Result.isSuccess(compile(c.spec, c.facts, emptyDefaults))),
    );
    expect(tags(single([suiteStep("tests")]))).toEqual([]);
  });

  it("[flow.opinion-only-routes] a step whose evidence is opinion or testimony may not pass", () => {
    fc.assert(
      fc.property(flowCaseArb(), fc.nat(), (c, i) => {
        const seeded = withStep(c, i, (s) => ({
          ...s,
          kind: "decision-model",
          evidenceCeiling: "opinion",
          outcomes: [...s.outcomes, "pass"],
          overrides: [],
        }));
        return tags(seeded).includes("OpinionMayOnlyRoute");
      }),
    );
    expect(tags(single([opinionStep("clef", ["pass", "abstain"])]))).toContain(
      "OpinionMayOnlyRoute",
    );
  });

  it("[flow.only-proof-or-ruling-fail] only proof and rulings may fail", () => {
    fc.assert(
      fc.property(flowCaseArb(), fc.nat(), (c, i) => {
        const seeded = withStep(c, i, (s) => ({
          ...s,
          kind: "generative",
          evidenceCeiling: "opinion",
          outcomes: [...s.outcomes, "fail"],
          overrides: [],
        }));
        return tags(seeded).includes("OnlyProofOrRulingMayFail");
      }),
    );
    const testimony = suiteStep("agent-says", {
      evidenceCeiling: "testimony",
      outcomes: ["fail", "abstain"],
    });
    expect(tags(single([testimony]))).toContain("OnlyProofOrRulingMayFail");
  });

  it("[flow.opinion-skips-only-optional] an opinion step may skip only optional steps", () => {
    fc.assert(
      fc.property(flowCaseArb({ maxSteps: 4 }), fc.nat(), (c, i) => {
        if (c.spec.steps.length < 2) return true;
        const target = c.spec.steps[(i + 1) % c.spec.steps.length];
        if (target === undefined) return true;
        const required = withStep(
          {
            ...c,
            spec: {
              ...c.spec,
              steps: c.spec.steps.map((s) => (s.id === target.id ? { ...s, optional: false } : s)),
            },
          },
          i,
          (s) =>
            s.id === target.id
              ? s
              : {
                  ...s,
                  kind: "decision-model",
                  evidenceCeiling: "opinion",
                  outcomes: ["escalate", "abstain"],
                  mayskip: [target.id],
                  overrides: [],
                },
        );
        return (
          required.spec.steps[i % required.spec.steps.length]?.id === target.id ||
          tags(required).includes("OpinionMaySkipOnlyOptional")
        );
      }),
    );
    const triage = { ...opinionStep("triage", ["annotate", "abstain"]), mayskip: ["slow"] };
    expect(tags(single([triage, suiteStep("slow")]))).toContain("OpinionMaySkipOnlyOptional");
    expect(tags(single([triage, suiteStep("slow", { optional: true })]))).toEqual([]);
  });

  it("[flow.only-human-overrides] only a human step may override a fail", () => {
    fc.assert(
      fc.property(flowCaseArb(), fc.nat(), (c, i) => {
        const seeded = withStep(c, i, (s) => ({
          ...s,
          kind: "deterministic",
          evidenceCeiling: "proof",
          overrides: [c.spec.steps[0]?.id ?? s.id],
        }));
        return tags(seeded).includes("OnlyHumanMayOverride");
      }),
    );
    const human = {
      ...suiteStep("ruling", { kind: "human", evidenceCeiling: "ruling", suite: false }),
      overrides: ["tests"],
    };
    expect(tags(single([suiteStep("tests"), human]))).toEqual([]);
  });

  it("[flow.abstain-required] every step must declare abstain", () => {
    fc.assert(
      fc.property(flowCaseArb(), fc.nat(), (c, i) => {
        const seeded = withStep(c, i, (s) => ({
          ...s,
          outcomes: s.outcomes.filter((o) => o !== "abstain"),
        }));
        return tags(seeded).includes("AbstainMissing");
      }),
    );
    expect(tags(single([suiteStep("tests", { outcomes: ["pass", "fail"] })]))).toContain(
      "AbstainMissing",
    );
  });

  it("[flow.taint-weakest-consumed] a step's effective class is the weakest it consumed, so model output is never laundered", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => {
        const plan = ok(c);
        const oracle = oracleEffective(c.spec);
        return plan.steps.every(
          (s) => s.id === HUMAN_CLASS_STEP || s.effectiveClass === oracle.get(s.id),
        );
      }),
    );
    const laundering = suiteStep("lint-with-clef", {
      reads: [{ _tag: "fact", fact: "derived-effects" }],
    });
    expect(tags(single([laundering]))).toEqual(["OnlyProofOrRulingMayFail", "OpinionMayOnlyRoute"]);
    const human = suiteStep("ruling", {
      kind: "human",
      evidenceCeiling: "ruling",
      suite: false,
      reads: [{ _tag: "fact", fact: "derived-effects" }],
    });
    expect(ok(single([human])).steps[0]?.effectiveClass).toBe("ruling");
  });

  it("[flow.structural-errors] malformed flows are refused, each with its own error", () => {
    const tests = suiteStep("tests");
    const cases: readonly (readonly [FlowCase, string])[] = [
      [single([tests], { _tag: "step", step: "missing" }), "UnknownStep"],
      [
        single([tests], {
          _tag: "par",
          items: [
            { _tag: "step", step: "tests" },
            { _tag: "step", step: "tests" },
          ],
        }),
        "StepUsedTwice",
      ],
      [
        single([tests, suiteStep("later")], {
          _tag: "seq",
          exitOn: "fail",
          items: [
            {
              _tag: "when",
              condition: { _tag: "outcome", step: "later", in: ["pass"] },
              body: { _tag: "step", step: "tests" },
            },
            { _tag: "step", step: "later" },
          ],
        }),
        "WhenRefersToNonPriorStep",
      ],
      [
        single([tests, suiteStep("next")], {
          _tag: "seq",
          exitOn: "fail",
          items: [
            { _tag: "step", step: "tests" },
            {
              _tag: "when",
              condition: { _tag: "outcome", step: "tests", in: ["escalate"] },
              body: { _tag: "step", step: "next" },
            },
          ],
        }),
        "WhenOutcomeNotDeclared",
      ],
      [
        single([tests], {
          _tag: "cascade",
          accept: ["annotate"],
          items: [{ _tag: "step", step: "tests" }],
        }),
        "CascadeAcceptUnreachable",
      ],
      [
        single([tests], {
          _tag: "worlds",
          over: ["A", "AB"],
          body: { _tag: "step", step: "tests" },
        }),
        "WorldNotSupported",
      ],
      [single([suiteStep("tests", { budget: { usd: -1, cpuMs: 0, tokens: 0 } })]), "InvalidBudget"],
      [
        single([suiteStep("tests", { reads: [{ _tag: "fact", fact: "nowhere" }] })]),
        "ReadsUnknown",
      ],
      [
        single([
          suiteStep("a", { reads: [{ _tag: "step", step: "b" }] }),
          suiteStep("b", { reads: [{ _tag: "step", step: "a" }] }),
        ]),
        "ReadCycle",
      ],
      [
        single([{ ...opinionStep("clef", ["escalate", "abstain"]), evidenceCeiling: "proof" }]),
        "KindCeilingMismatch",
      ],
      [
        single([tests], {
          _tag: "cascade",
          accept: ["pass", "abstain"],
          items: [{ _tag: "step", step: "tests" }],
        }),
        "CascadeMayNotAcceptAbstain",
      ],
    ];
    for (const [c, tag] of cases) expect(tags(c)).toContain(tag);
  });

  it("[flow.opinion-gates-only-add-scrutiny] a when may consult an opinion only to switch extra checks on", () => {
    const clef = opinionStep("clef", ["escalate", "annotate", "abstain"]);
    const deep = suiteStep("deep");
    const gated = (condition: Condition): FlowCase => single([clef, deep], whenOn(condition));
    expect(tags(gated({ _tag: "outcome", step: "clef", in: ["escalate"] }))).toEqual([]);
    expect(tags(gated({ _tag: "outcome", step: "clef", in: ["annotate"] }))).toContain(
      "WhenOnOpinionMayOnlyAddScrutiny",
    );
    expect(
      tags(gated({ _tag: "not", item: { _tag: "outcome", step: "clef", in: ["escalate"] } })),
    ).toContain("WhenOnOpinionMayOnlyAddScrutiny");
    const proof = suiteStep("tests");
    expect(
      tags(
        single(
          [proof, deep],
          whenOn({ _tag: "not", item: { _tag: "outcome", step: "tests", in: ["pass"] } }, "tests"),
        ),
      ),
    ).toEqual([]);
  });
});

describe("flow compiler: plans", () => {
  it("[flow.spec-from-base] a spec not read from the change's base commit is refused", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) =>
        tags({ ...c, spec: { ...c.spec, commit: otherCommit } }).includes("SpecNotFromBase"),
      ),
    );
    const viaDefaults = compile(undefined, single([suiteStep("tests")]).facts, {
      flow: { _tag: "step", step: "tests" },
      steps: [suiteStep("tests")],
    });
    expect(Result.isSuccess(viaDefaults)).toBe(true);
  });

  it("[flow.human-class-when-flow-touched] a change that touches .keel/flow is human-class, and only such a change", () => {
    fc.assert(
      fc.property(flowCaseArb(), fc.boolean(), (c, touchFlow) => {
        const touched = touchFlow
          ? [...c.facts.touchedPaths, ".keel/flow.ts"]
          : c.facts.touchedPaths.filter((p) => !p.startsWith(".keel/"));
        const plan = ok({ ...c, facts: { ...c.facts, touchedPaths: touched } });
        const gate = plan.steps.find((s) => s.id === HUMAN_CLASS_STEP);
        return (
          plan.humanClass === touchFlow &&
          (gate !== undefined) === touchFlow &&
          (gate === undefined || (gate.kind === "human" && gate.optional === false))
        );
      }),
    );
    const flowEdit = {
      ...single([suiteStep("tests")]),
      facts: { ...single([suiteStep("tests")]).facts, touchedPaths: [".keel/flow.yaml"] },
    };
    expect(ok(flowEdit).steps.map((s) => s.id)).toEqual(["tests", HUMAN_CLASS_STEP]);
  });

  it("[flow.plan-hash-content-addressed] the plan hash depends on content alone, including each step's version", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => {
        const plan = ok(c);
        const reordered: FlowCase = {
          ...c,
          spec: { steps: c.spec.steps.map(reverseKeys), flow: c.spec.flow, commit: c.spec.commit },
        };
        expect(ok(reordered).planHash).toBe(plan.planHash);
        const first = plan.steps.find((s) => s.id !== HUMAN_CLASS_STEP);
        if (first === undefined) return;
        const bumped = {
          ...c,
          spec: {
            ...c.spec,
            steps: c.spec.steps.map((s) =>
              s.id === first.id ? { ...s, version: contentHashOf({ bumped: s.id }) } : s,
            ),
          },
        };
        expect(ok(bumped).planHash).not.toBe(plan.planHash);
      }),
    );
  });

  it("[flow.steps-cited-and-pruned] a step is planned exactly when it applies to the change, and says why", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => {
        const plan = ok(c);
        const planned = new Set(plan.steps.map((s) => s.id));
        const appliesTo = (s: StepSpec): boolean =>
          (s.appliesTo.paths.length === 0 && s.appliesTo.subjects.length === 0) ||
          s.appliesTo.paths.some((g) => c.facts.touchedPaths.some((p) => matchesGlob(g, p))) ||
          s.appliesTo.subjects.some((k) =>
            c.facts.subjects.some((t) => t === k || t.startsWith(`${k}.`) || k.startsWith(`${t}.`)),
          );
        return (
          plan.steps.every((s) => s.because.length > 0) &&
          c.spec.steps.every((s) => planned.has(s.id) === appliesTo(s))
        );
      }),
    );
    const billing = suiteStep("billing-suite", {
      appliesTo: { paths: [Glob.make("src/billing/**")], subjects: [] },
    });
    expect(ok(single([suiteStep("tests"), billing])).steps.map((s) => s.id)).toEqual(["tests"]);
  });

  it("[flow.tier-policy] suites default to containers, probes and pure checks to isolates, pins win, and each choice says why", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => {
        const byId = new Map(c.spec.steps.map((s) => [s.id, s]));
        return ok(c).steps.every((p) => {
          const s = byId.get(p.id);
          if (s === undefined) return p.id === HUMAN_CLASS_STEP;
          const expected =
            s.tier ??
            (s.kind === "human"
              ? 0
              : s.suite
                ? defaultFlowPolicy.suiteTier
                : defaultFlowPolicy.defaultTier);
          return p.tier.tier === expected && p.tier.reason.length > 0;
        });
      }),
    );
    const plan = ok(
      single([suiteStep("tests"), suiteStep("probe", { kind: "probe", suite: false })]),
    );
    expect(plan.steps.map((s) => s.tier.tier)).toEqual([2, 1]);
  });

  it("[flow.cost-sums-steps-per-world] the cost estimate sums each planned step's budget once per world it runs in", () => {
    fc.assert(
      fc.property(flowCaseArb(), (c) => {
        const plan = ok(c);
        const byId = new Map(c.spec.steps.map((s) => [s.id, s]));
        const expected = plan.steps.reduce(
          (sum, p) => sum + (byId.get(p.id)?.budget.usd ?? 0) * Math.max(1, p.worlds?.length ?? 1),
          0,
        );
        return Math.abs(plan.costEstimate - expected) < 1e-12;
      }),
    );
    const matrix = suiteStep("probe", {
      kind: "probe",
      suite: false,
      worlds: ["trunk", "A", "AB"],
      budget: { usd: 0.01, cpuMs: 10, tokens: 0 },
    });
    const plan = ok(
      single([matrix], {
        _tag: "worlds",
        over: ["trunk", "A", "AB"],
        body: { _tag: "step", step: "probe" },
      }),
    );
    expect(plan.costEstimate).toBeCloseTo(0.03, 12);
  });
});
