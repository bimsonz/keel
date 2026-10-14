import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { SubjectKey } from "../../../src/domain/coordination/index.ts";
import {
  contentHashOf,
  type EvidenceClass,
  Glob,
  makeId,
  matchesGlob,
  weakest,
} from "../../../src/domain/kernel/index.ts";
import {
  type AdmittedGuard,
  type CompileError,
  compile,
  type Condition,
  defaultFlowPolicy,
  type FlowDefinition,
  type FlowPlan,
  HUMAN_CLASS_STEP,
  type PlanPreimage,
  planHashOf,
  type StepSpec,
  guardSteps,
} from "../../../src/domain/verification/index.ts";
import {
  base,
  emptyDefaults,
  type FlowCase,
  factClasses,
  flowCaseArb,
  guardedCaseArb,
  otherCommit,
  probeOf,
  ruledCaseArb,
} from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";

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

/** Everything a plan's hash covers, perturbed one field at a time: each must move the hash. */
const perturbations = (plan: FlowPlan): readonly PlanPreimage[] => {
  const first = plan.steps[0];
  const guarded = plan.steps.findIndex((s) => s.guards !== undefined);
  const flipped = (i: number): FlowPlan["steps"] =>
    plan.steps.map((s, j) =>
      j === i && s.guards !== undefined
        ? {
            ...s,
            guards: { ...s.guards, policy: s.guards.policy === "block" ? "advise" : "block" },
          }
        : s,
    );
  return [
    { ...plan, humanClass: !plan.humanClass },
    { ...plan, compiler: "flow-compiler/0" },
    { ...plan, baseCommit: otherCommit },
    { ...plan, members: [plan.planHash] },
    { ...plan, flow: { _tag: "par", items: [plan.flow] } },
    { ...plan, mayskip: { ...plan.mayskip, extra: ["x"] } },
    { ...plan, overrides: { ...plan.overrides, extra: ["x"] } },
    ...(first === undefined
      ? []
      : [
          {
            ...plan,
            versions: { ...plan.versions, [first.id]: contentHashOf({ other: first.id }) },
          },
          {
            ...plan,
            steps: plan.steps.map((s, j) => (j === 0 ? { ...s, because: "changed" } : s)),
          },
        ]),
    ...(guarded === -1 ? [] : [{ ...plan, steps: flipped(guarded) }]),
  ];
};

/** The plan with its first guard step pinning another probe, or undefined when it has none. */
const repinned = (plan: FlowPlan): PlanPreimage | undefined => {
  const i = plan.steps.findIndex((s) => s.guards !== undefined);
  if (i === -1) return undefined;
  return {
    ...plan,
    steps: plan.steps.map((s, j) =>
      j === i && s.guards !== undefined
        ? { ...s, guards: { ...s.guards, probe: contentHashOf({ other: s.guards.probe }) } }
        : s,
    ),
  };
};

describe("flow-compiler/2: what a plan's hash covers", () => {
  it("[flow.hash-pins-probe] a plan whose guard step pins another probe is another plan", () => {
    let guarded = 0;
    fc.assert(
      fc.property(guardedCaseArb(), (c) => {
        const plan = ok(c);
        const other = repinned(plan);
        if (other === undefined) return true;
        guarded++;
        return planHashOf(other) !== plan.planHash;
      }),
    );
    expect(guarded).toBeGreaterThan(0);
    const plan = ok(
      single([{ ...suiteStep("g"), guards: { predicate: "freshness", probe: probeOf("g") } }]),
    );
    const other = repinned(plan);
    expect(other?.steps[0]?.guards?.probe).not.toBe(probeOf("g"));
    expect(other === undefined ? plan.planHash : planHashOf(other)).not.toBe(plan.planHash);
  });

  it("[flow.plan-hash-preimage] a plan rehashes to its own hash, every field that affects execution moves it, and the cost estimate does not", () => {
    let guards = 0;
    fc.assert(
      fc.property(guardedCaseArb(), (c) => {
        const plan = ok(c);
        if (plan.steps.some((s) => s.guards !== undefined)) guards++;
        return (
          plan.compiler === "flow-compiler/2" &&
          planHashOf(plan) === plan.planHash &&
          planHashOf({ ...plan, costEstimate: plan.costEstimate + 1 } as PlanPreimage) ===
            plan.planHash &&
          perturbations(plan).every((changed) => planHashOf(changed) !== plan.planHash)
        );
      }),
    );
    expect(guards).toBeGreaterThan(0);
    // A change that touches the flow differs from one that doesn't only by its gate, and the hash says so.
    const plan = ok({
      spec: single([suiteStep("tests")]).spec,
      facts: { ...single([suiteStep("tests")]).facts, touchedPaths: [".keel/flow.ts", "src/a.ts"] },
    });
    expect(plan.humanClass).toBe(true);
    expect(planHashOf({ ...plan, humanClass: false })).not.toBe(plan.planHash);
  });

  it("[flow.step-run] a step's command rides on its plan step, in a container, its timeout filled in, and the plan's hash covers both", () => {
    const check = suiteStep("check", { suite: false, run: { command: "pnpm test" } });
    const plan = ok(single([check]));
    expect(plan.steps.map((s) => [s.id, s.run, s.tier])).toEqual([
      [
        "check",
        { command: "pnpm test", timeoutMs: 240_000 },
        { tier: 2, reason: "a command of the project's own runs in a container" },
      ],
    ]);
    // A pinned tier gives way: a command runs nowhere but a container.
    expect(ok(single([{ ...check, tier: 1 }])).steps[0]?.tier.tier).toBe(2);
    const hashWith = (run: NonNullable<StepSpec["run"]>) =>
      ok(single([{ ...check, run }])).planHash;
    expect(hashWith({ command: "pnpm test --bail" })).not.toBe(plan.planHash);
    expect(hashWith({ command: "pnpm test", timeoutMs: 300_000 })).not.toBe(plan.planHash);
    // At compile the default written out is the same plan; through parseFlow it is not, since the step's version is the hash of the step as written.
    expect(hashWith({ command: "pnpm test", timeoutMs: 240_000 })).toBe(plan.planHash);
    // A suite step may carry a command of its own (ruled 14 Oct): it rides, in a container.
    expect(
      ok(single([suiteStep("check", { run: { command: "pnpm test" } })])).steps.map((s) => [
        s.run,
        s.tier.tier,
      ]),
    ).toEqual([[{ command: "pnpm test", timeoutMs: 240_000 }, 2]]);
    expect(ok(single([suiteStep("check")])).steps[0]).not.toHaveProperty("run");
  });

  it("[flow.guard-policy] a guard step carries its predicate's policy, and a predicate the change's policy leaves out is advise", () => {
    let defaulted = 0;
    let named = 0;
    assertReaching(
      fc.property(guardedCaseArb(), (c) => {
        const plan = ok(c);
        const specs = new Map(c.spec.steps.map((s) => [s.id, s]));
        return plan.steps.every((p) => {
          const predicate = specs.get(p.id)?.guards?.predicate;
          if (predicate === undefined) return p.guards === undefined;
          const chosen = c.facts.predicatePolicy?.[predicate];
          if (chosen === undefined) defaulted++;
          else named++;
          return p.guards?.predicate === predicate && p.guards.policy === (chosen ?? "advise");
        });
      }),
    );
    expect(defaulted).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(0);
    const probe = probeOf("guard");
    const guard = { ...suiteStep("guard"), guards: { predicate: "freshness" as const, probe } };
    const unset = ok(single([guard]));
    expect(unset.steps[0]?.guards).toEqual({ predicate: "freshness", policy: "advise", probe });
    const blocked = ok({
      spec: single([guard]).spec,
      facts: { ...single([guard]).facts, predicatePolicy: { freshness: "block" } },
    });
    expect(blocked.steps[0]?.guards).toEqual({ predicate: "freshness", policy: "block", probe });
    expect(blocked.planHash).not.toBe(unset.planHash);
  });

  it("[flow.guard-ruled] a guard that holds a decision blocks whatever its predicate's policy and its step carries the decision; every other guard is as the policy has it and carries none", () => {
    const ruledUnder = { block: 0, advise: 0, annotate: 0, unset: 0 };
    let unruled = 0;
    assertReaching(
      fc.property(ruledCaseArb(), (c) => {
        const plan = ok(c);
        const specs = new Map(c.spec.steps.map((s) => [s.id, s]));
        return plan.steps.every((p) => {
          const guards = specs.get(p.id)?.guards;
          if (guards === undefined) return p.guards === undefined;
          const chosen = c.facts.predicatePolicy?.[guards.predicate];
          if (guards.decision === undefined) {
            unruled++;
            return p.guards?.policy === (chosen ?? "advise") && !("decision" in p.guards);
          }
          ruledUnder[chosen ?? "unset"]++;
          return (
            p.guards?.policy === "block" &&
            JSON.stringify(p.guards.decision) === JSON.stringify(guards.decision)
          );
        });
      }),
    );
    expect(Object.values(ruledUnder).every((n) => n > 0)).toBe(true);
    expect(unruled).toBeGreaterThan(0);

    const probe = probeOf("guard");
    const decision = { id: makeId("dec", "1".padStart(26, "0")), summary: "The premise holds" };
    const annotated = (held?: typeof decision): FlowPlan => {
      const guards = {
        predicate: "freshness" as const,
        probe,
        ...(held ? { decision: held } : {}),
      };
      const one = single([{ ...suiteStep("guard"), guards }]);
      return ok({
        spec: one.spec,
        facts: { ...one.facts, predicatePolicy: { freshness: "annotate" } },
      });
    };
    const ruled = annotated(decision);
    const other = annotated({ ...decision, id: makeId("dec", "2".padStart(26, "0")) });
    expect(annotated().steps[0]?.guards).toEqual({
      predicate: "freshness",
      policy: "annotate",
      probe,
    });
    expect(ruled.steps[0]?.guards).toEqual({
      predicate: "freshness",
      policy: "block",
      probe,
      decision,
    });
    expect(new Set([annotated().planHash, ruled.planHash, other.planHash]).size).toBe(3);
  });

  it("[flow.guard-probe-pinned] a guard step runs the probe its own spec pins, never another guard's", () => {
    let several = 0;
    fc.assert(
      fc.property(guardedCaseArb(), (c) => {
        const plan = ok(c);
        const specs = new Map(c.spec.steps.map((s) => [s.id, s]));
        if (plan.steps.filter((p) => p.guards !== undefined).length > 1) several++;
        return plan.steps.every(
          (p) => p.guards === undefined || p.guards.probe === specs.get(p.id)?.guards?.probe,
        );
      }),
    );
    expect(several).toBeGreaterThan(0);
    const pair = ok(
      single([
        { ...suiteStep("g1"), guards: { predicate: "freshness", probe: probeOf("g1") } },
        { ...suiteStep("g2"), guards: { predicate: "authority", probe: probeOf("g2") } },
      ]),
    );
    expect(pair.steps.map((s) => [s.id, s.guards?.probe])).toEqual([
      ["g1", probeOf("g1")],
      ["g2", probeOf("g2")],
    ]);
  });
});

/** Admitted guards on subjects some flow cases touch and some don't. */
const guardSubjects = [
  "authz",
  "authz.cache",
  "billing.audit-log",
  "billing",
  "ops.deploy",
] as const;
const admittedArb: fc.Arbitrary<readonly AdmittedGuard[]> = fc
  .subarray([1, 2, 3], { maxLength: 3 })
  .chain((ns) =>
    fc.tuple(
      ...ns.map((n) =>
        fc.constantFrom(...guardSubjects).map((subject): AdmittedGuard => ({
          guardId: makeId("grd", String(n).padStart(26, "0")),
          probe: contentHashOf({ probe: n }),
          tenet: {
            id: makeId("tnt", String(n).padStart(26, "0")),
            proposition: {
              subject: SubjectKey.make(subject),
              predicate: "freshness",
              relation: "at-most",
              value: "per-request",
            },
          },
        })),
      ),
    ),
  );

const withGuards = (c: FlowCase, admittedGuards: readonly AdmittedGuard[]): FlowCase => ({
  spec: c.spec,
  facts: { ...c.facts, admittedGuards },
});
/** The flow under the human-class gate, when the plan has one. */
const bodyOf = (plan: FlowPlan): unknown =>
  plan.humanClass && plan.flow._tag === "seq" ? plan.flow.items[0] : plan.flow;

describe("flow-compiler/2: the admitted guards a change runs", () => {
  it("[flow.guards-appended] compile plans every guard the change is exposed to, each pinned to its probe, and without guards the plan is unchanged", () => {
    let planned = 0;
    fc.assert(
      fc.property(flowCaseArb(), admittedArb, (c, admitted) => {
        const bare = ok(c);
        const none = ok(withGuards(c, []));
        const guarded = ok(withGuards(c, admitted));
        const selected = guardSteps(admitted, c.facts);
        planned += selected.length;
        const byId = new Map(guarded.steps.map((s) => [s.id, s]));
        return (
          JSON.stringify(none) === JSON.stringify(bare) &&
          selected.every((g) => byId.get(g.id)?.guards?.probe === g.guards?.probe) &&
          guarded.steps.length === bare.steps.length + selected.length
        );
      }),
    );
    expect(planned).toBeGreaterThan(0);
    const c = single([suiteStep("tests")]);
    const on: AdmittedGuard = {
      guardId: makeId("grd", "1".padStart(26, "0")),
      probe: contentHashOf({ probe: 1 }),
      tenet: {
        id: makeId("tnt", "1".padStart(26, "0")),
        proposition: {
          subject: SubjectKey.make("authz.cache"),
          predicate: "freshness",
          relation: "at-most",
          value: "per-request",
        },
      },
    };
    const plan = ok(withGuards(c, [on]));
    expect(plan.steps.map((s) => [s.id, s.guards?.probe])).toEqual([
      ["tests", undefined],
      [`guard:${on.guardId}`, on.probe],
    ]);
    expect(plan.planHash).not.toBe(ok(c).planHash);
  });

  it("[flow.guards-parallel] guards run alongside the project's flow, never after it", () => {
    let both = 0;
    fc.assert(
      fc.property(flowCaseArb(), admittedArb, (c, admitted) => {
        const selected = guardSteps(admitted, c.facts);
        const bare = ok(c);
        const projectRuns = bare.steps.some((s) => s.id !== HUMAN_CLASS_STEP);
        if (selected.length === 0 || !projectRuns) return true;
        both++;
        const guards = { _tag: "par", items: selected.map((s) => ({ _tag: "step", step: s.id })) };
        return (
          JSON.stringify(bodyOf(ok(withGuards(c, admitted)))) ===
          JSON.stringify({ _tag: "par", items: [bodyOf(bare), guards] })
        );
      }),
    );
    expect(both).toBeGreaterThan(0);
  });
});
