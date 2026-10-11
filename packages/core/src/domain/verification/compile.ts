import { Result } from "effect";
import { subjectsRelated } from "../coordination/index.ts";
import {
  canBlock,
  type ContentHash,
  contentHashOf,
  DEFAULT_PREDICATE_POLICY,
  type EvidenceClass,
  Glob,
  type Json,
  matchesGlob,
  type TierChoice,
  weakest,
} from "../kernel/index.ts";
import type { FlowWorld } from "./conflict.ts";
import {
  AbstainMissing,
  CascadeAcceptUnreachable,
  CascadeMayNotAcceptAbstain,
  type CompileError,
  InvalidBudget,
  KindCeilingMismatch,
  OnlyHumanMayOverride,
  OnlyProofOrRulingMayFail,
  OpinionMayOnlyRoute,
  OpinionMaySkipOnlyOptional,
  ReadCycle,
  ReadsUnknown,
  SpecNotFromBase,
  StepUsedTwice,
  UnknownStep,
  WhenOnOpinionMayOnlyAddScrutiny,
  WhenOutcomeNotDeclared,
  WhenRefersToNonPriorStep,
  WorldNotSupported,
} from "./errors.ts";
import type {
  Budget,
  ChangeFacts,
  Condition,
  Flow,
  FlowDefaults,
  FlowDefinition,
  FlowPlan,
  FlowPolicy,
  PlanPreimage,
  StepSpec,
} from "./flow.ts";
import type { PlanStep } from "./plan.ts";

/**
 * Bumped whenever compile's output for the same input changes. Part of every
 * plan hash. flow-compiler/2 hashes everything that affects execution,
 * `humanClass` and each guard's policy included, and records the preimage on
 * the plan (`compiler`, `versions`) so a stored plan can be rehashed.
 */
export const COMPILER_VERSION = "flow-compiler/2";

export const defaultFlowPolicy: FlowPolicy = {
  humanClassPaths: [
    Glob.make(".keel/flow*"),
    Glob.make(".keel/flow/**"),
    Glob.make(".keel/plugins/**"),
  ],
  suiteTier: 2,
  defaultTier: 1,
};

/** The step appended when a change touches the flow itself: a person must rule. */
export const HUMAN_CLASS_STEP = "keel.human-class";

// ------------------------------------------------------------------ structure

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

type Atom = {
  readonly step: string;
  readonly outcomes: readonly string[];
  readonly negated: boolean;
};

const conditionSteps = (c: Condition, negated = false): readonly Atom[] => {
  switch (c._tag) {
    case "outcome":
      return [{ step: c.step, outcomes: c.in, negated }];
    case "not":
      return conditionSteps(c.item, !negated);
    default:
      return c.items.flatMap((i) => conditionSteps(i, negated));
  }
};

const budgetValid = (b: Budget): boolean =>
  [b.usd, b.cpuMs, b.tokens].every((n) => Number.isFinite(n) && n >= 0);

/** Structural errors, walking the tree with the set of steps that have already run (`prior`). */
const checkStructure = (
  flow: Flow,
  table: ReadonlyMap<string, StepSpec>,
  classes: ReadonlyMap<string, EvidenceClass>,
  prior: ReadonlySet<string>,
  worlds: readonly FlowWorld[] | undefined,
): { readonly errors: readonly CompileError[]; readonly ran: ReadonlySet<string> } => {
  switch (flow._tag) {
    case "step": {
      const spec = table.get(flow.step);
      if (spec === undefined)
        return {
          errors: [new UnknownStep({ step: flow.step })],
          ran: new Set([...prior, flow.step]),
        };
      const unsupported = (worlds ?? []).filter((w) => !(spec.worlds ?? []).includes(w));
      return {
        errors: unsupported.map((world) => new WorldNotSupported({ step: flow.step, world })),
        ran: new Set([...prior, flow.step]),
      };
    }
    case "seq":
    case "cascade": {
      const errors: CompileError[] = [];
      let ran = prior;
      for (const item of flow.items) {
        const r = checkStructure(item, table, classes, ran, worlds);
        errors.push(...r.errors);
        ran = r.ran;
      }
      if (flow._tag === "cascade") {
        const reachable = flow.items
          .flatMap(stepsIn)
          .some((s) => (table.get(s)?.outcomes ?? []).some((o) => flow.accept.includes(o)));
        if (!reachable) errors.push(new CascadeAcceptUnreachable({ accept: [...flow.accept] }));
        if (flow.accept.includes("abstain")) errors.push(new CascadeMayNotAcceptAbstain());
      }
      return { errors, ran };
    }
    case "par": {
      const results = flow.items.map((item) => checkStructure(item, table, classes, prior, worlds));
      return {
        errors: results.flatMap((r) => r.errors),
        ran: new Set([...prior, ...results.flatMap((r) => [...r.ran])]),
      };
    }
    case "worlds":
      return checkStructure(flow.body, table, classes, prior, flow.over);
    case "when": {
      const errors: CompileError[] = conditionSteps(flow.condition).flatMap(
        ({ step, outcomes, negated }): CompileError[] => {
          if (!prior.has(step)) return [new WhenRefersToNonPriorStep({ step })];
          const declared = table.get(step)?.outcomes ?? [];
          const undeclared = outcomes
            .filter((o) => !declared.some((d) => d === o))
            .map((outcome) => new WhenOutcomeNotDeclared({ step, outcome }));
          const opinion = !canBlock(classes.get(step) ?? "opinion");
          const quiets = opinion && (negated || outcomes.includes("annotate"));
          return quiets
            ? [...undeclared, new WhenOnOpinionMayOnlyAddScrutiny({ step })]
            : undeclared;
        },
      );
      const body = checkStructure(flow.body, table, classes, prior, worlds);
      return { errors: [...errors, ...body.errors], ran: body.ran };
    }
    default: {
      const body = checkStructure(flow.body, table, classes, prior, worlds);
      return {
        errors: budgetValid(flow.limit)
          ? body.errors
          : [new InvalidBudget({ where: "budget node" }), ...body.errors],
        ran: body.ran,
      };
    }
  }
};

// ---------------------------------------------------------------------- taint

/**
 * A step's effective class is the weakest it consumed: its ceiling, weakened
 * by every step and fact it reads, transitively. A human decision is always a
 * ruling: people decide.
 */
const effectiveClasses = (
  table: ReadonlyMap<string, StepSpec>,
  facts: ChangeFacts["facts"],
): {
  readonly classes: ReadonlyMap<string, EvidenceClass>;
  readonly errors: readonly CompileError[];
} => {
  const classes = new Map<string, EvidenceClass>();
  const errors: CompileError[] = [];
  const visiting: string[] = [];
  const cyclic = new Set<string>();

  const visit = (id: string): EvidenceClass => {
    const known = classes.get(id);
    if (known !== undefined) return known;
    const spec = table.get(id);
    if (spec === undefined) return "opinion";
    if (visiting.includes(id)) {
      const cycle = visiting.slice(visiting.indexOf(id));
      if (!cycle.some((s) => cyclic.has(s))) errors.push(new ReadCycle({ steps: cycle }));
      for (const s of cycle) cyclic.add(s);
      return "opinion";
    }
    visiting.push(id);
    const consumed = spec.reads.map((read): EvidenceClass => {
      if (read._tag === "fact") {
        const cls = facts[read.fact];
        if (cls === undefined)
          errors.push(new ReadsUnknown({ step: id, read: `fact:${read.fact}` }));
        return cls ?? "opinion";
      }
      if (!table.has(read.step))
        errors.push(new ReadsUnknown({ step: id, read: `step:${read.step}` }));
      return visit(read.step);
    });
    visiting.pop();
    const effective =
      spec.kind === "human" ? "ruling" : consumed.reduce(weakest, spec.evidenceCeiling);
    classes.set(id, effective);
    return effective;
  };

  for (const id of table.keys()) visit(id);
  return { classes, errors };
};

// -------------------------------------------------------------- typing rules

const ceilingFits = (spec: StepSpec): boolean => {
  switch (spec.kind) {
    case "decision-model":
    case "generative":
      return spec.evidenceCeiling === "opinion";
    case "human":
      return spec.evidenceCeiling === "ruling";
    default:
      return true;
  }
};

const typeStep = (
  spec: StepSpec,
  effective: EvidenceClass,
  table: ReadonlyMap<string, StepSpec>,
): readonly CompileError[] => {
  const errors: CompileError[] = [];
  if (!spec.outcomes.includes("abstain")) errors.push(new AbstainMissing({ step: spec.id }));
  if (!ceilingFits(spec))
    errors.push(
      new KindCeilingMismatch({ step: spec.id, kind: spec.kind, ceiling: spec.evidenceCeiling }),
    );
  const decides = canBlock(effective);
  if (!decides && spec.outcomes.includes("fail"))
    errors.push(new OnlyProofOrRulingMayFail({ step: spec.id, effectiveClass: effective }));
  if (!decides && spec.outcomes.includes("pass"))
    errors.push(new OpinionMayOnlyRoute({ step: spec.id, outcome: "pass" }));
  for (const target of spec.mayskip) {
    const skipped = table.get(target);
    if (skipped === undefined) errors.push(new UnknownStep({ step: target }));
    else if (!decides && !skipped.optional)
      errors.push(new OpinionMaySkipOnlyOptional({ step: spec.id, target }));
  }
  if (spec.overrides.length > 0 && spec.kind !== "human")
    errors.push(new OnlyHumanMayOverride({ step: spec.id, kind: spec.kind }));
  for (const target of spec.overrides)
    if (!table.has(target)) errors.push(new UnknownStep({ step: target }));
  return errors;
};

// ------------------------------------------------------------------- pruning

type Applies = { readonly applies: boolean; readonly because: readonly string[] };

const applies = (spec: StepSpec, facts: ChangeFacts): Applies => {
  if (spec.appliesTo.paths.length === 0 && spec.appliesTo.subjects.length === 0) {
    return { applies: true, because: ["applies to every change"] };
  }
  const paths = spec.appliesTo.paths.flatMap((glob) =>
    facts.touchedPaths.filter((p) => matchesGlob(glob, p)).map((p) => `touches ${p} (${glob})`),
  );
  const subjects = spec.appliesTo.subjects.flatMap((s) =>
    facts.subjects.filter((t) => subjectsRelated(s, t)).map((t) => `relies on or alters ${t}`),
  );
  const because = [...paths, ...subjects];
  return { applies: because.length > 0, because };
};

/**
 * Drops steps that do not apply to this change. A `when` whose condition
 * names a dropped step keeps its body unconditionally, so pruning never
 * removes scrutiny by accident; containers left empty disappear.
 */
const prune = (flow: Flow, keep: ReadonlySet<string>): Flow | undefined => {
  switch (flow._tag) {
    case "step":
      return keep.has(flow.step) ? flow : undefined;
    case "seq":
    case "par":
    case "cascade": {
      const items = flow.items.flatMap((i) => prune(i, keep) ?? []);
      return items.length === 0 ? undefined : { ...flow, items };
    }
    case "when": {
      const body = prune(flow.body, keep);
      if (body === undefined) return undefined;
      const referentsKept = conditionSteps(flow.condition).every(({ step }) => keep.has(step));
      return referentsKept ? { ...flow, body } : body;
    }
    default: {
      const body = prune(flow.body, keep);
      return body === undefined ? undefined : { ...flow, body };
    }
  }
};

// ---------------------------------------------------------------- planning

const tierFor = (spec: StepSpec, policy: FlowPolicy): TierChoice => {
  if (spec.tier !== undefined)
    return { tier: spec.tier, reason: "pinned by the project's flow spec" };
  if (spec.kind === "human")
    return { tier: 0, reason: "a human decision: the workflow waits for the event" };
  if (spec.suite)
    return { tier: policy.suiteTier, reason: "policy: project suites run in containers" };
  return { tier: policy.defaultTier, reason: "policy: probes and pure checks run in isolates" };
};

const worldsOf = (
  flow: Flow,
  inherited: readonly FlowWorld[] | undefined,
  out: Map<string, readonly FlowWorld[] | undefined>,
): void => {
  switch (flow._tag) {
    case "step":
      out.set(flow.step, inherited);
      return;
    case "seq":
    case "par":
    case "cascade":
      for (const item of flow.items) worldsOf(item, inherited, out);
      return;
    case "worlds":
      worldsOf(flow.body, flow.over, out);
      return;
    default:
      worldsOf(flow.body, inherited, out);
  }
};

const humanClassStep: StepSpec = {
  id: HUMAN_CLASS_STEP,
  version: contentHashOf({ step: HUMAN_CLASS_STEP, compiler: COMPILER_VERSION }),
  kind: "human",
  evidenceCeiling: "ruling",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0, cpuMs: 0, tokens: 0 },
  determinism: "nondeterministic",
  suite: false,
  optional: false,
};

const toJson = (value: unknown): Json => JSON.parse(JSON.stringify(value) ?? "null");

/**
 * A plan's content hash: everything that affects how it runs and what its
 * verdict says, and nothing else. The cost estimate is advisory and stays
 * outside, as does the hash itself. A plan read back from storage is genuine
 * only if this equals its `planHash`.
 */
export const planHashOf = (plan: PlanPreimage): ContentHash =>
  contentHashOf(
    toJson({
      compiler: plan.compiler,
      baseCommit: plan.baseCommit,
      flow: plan.flow,
      steps: plan.steps,
      versions: plan.versions,
      overrides: plan.overrides,
      mayskip: plan.mayskip,
      humanClass: plan.humanClass,
      ...(plan.members === undefined ? {} : { members: plan.members }),
    }),
  );

/**
 * Compiles a change's Verification Plan: a pure function of the flow spec as
 * read from the base commit (`spec`; Keel's `defaults` when the project has
 * none), the change's facts, and policy. Every typing rule is checked on the
 * whole spec, so a spec is well-typed whatever change it meets; then the steps
 * that do not apply are pruned, and each kept step cites why it is there.
 */
export const compile = (
  spec: FlowDefinition | undefined,
  facts: ChangeFacts,
  defaults: FlowDefaults,
  policy: FlowPolicy = defaultFlowPolicy,
): Result.Result<FlowPlan, readonly [CompileError, ...CompileError[]]> => {
  const errors: CompileError[] = [];
  if (spec !== undefined && spec.commit !== facts.baseCommit) {
    errors.push(new SpecNotFromBase({ specCommit: spec.commit, baseCommit: facts.baseCommit }));
  }
  const table = new Map<string, StepSpec>();
  for (const s of [...defaults.steps, ...(spec?.steps ?? [])]) table.set(s.id, s);
  const flow = spec?.flow ?? defaults.flow;

  const taint = effectiveClasses(table, facts.facts);
  const used = stepsIn(flow);
  for (const step of new Set(used.filter((s, i) => used.indexOf(s) !== i)))
    errors.push(new StepUsedTwice({ step }));
  errors.push(...checkStructure(flow, table, taint.classes, new Set(), undefined).errors);
  for (const s of table.values())
    if (!budgetValid(s.budget)) errors.push(new InvalidBudget({ where: `step ${s.id}` }));
  errors.push(...taint.errors);
  for (const s of table.values())
    errors.push(...typeStep(s, taint.classes.get(s.id) ?? "opinion", table));

  const [first, ...rest] = errors;
  if (first !== undefined) return Result.fail([first, ...rest]);

  const reasons = new Map(
    used.map((id) => [id, applies(table.get(id) ?? humanClassStep, facts)] as const),
  );
  const kept = new Set(used.filter((id) => reasons.get(id)?.applies === true));
  const touchesFlow = facts.touchedPaths.filter((p) =>
    policy.humanClassPaths.some((g) => matchesGlob(g, p)),
  );
  const pruned = prune(flow, kept);
  const gate: Flow = { _tag: "step", step: HUMAN_CLASS_STEP };
  const compiled: Flow =
    touchesFlow.length === 0
      ? (pruned ?? { _tag: "seq", exitOn: "fail", items: [] })
      : { _tag: "seq", exitOn: "fail", items: pruned === undefined ? [gate] : [pruned, gate] };
  if (touchesFlow.length > 0) {
    table.set(HUMAN_CLASS_STEP, humanClassStep);
    reasons.set(HUMAN_CLASS_STEP, {
      applies: true,
      because: [`human-class: touches ${touchesFlow.join(", ")}`],
    });
  }

  const worlds = new Map<string, readonly FlowWorld[] | undefined>();
  worldsOf(compiled, undefined, worlds);
  const planned = stepsIn(compiled).flatMap((id): PlanStep[] => {
    const s = table.get(id);
    if (s === undefined) return [];
    const w = worlds.get(id);
    return [
      {
        id,
        kind: s.kind,
        evidenceCeiling: s.evidenceCeiling,
        appliesTo: s.appliesTo.paths,
        tier: tierFor(s, policy),
        because: (reasons.get(id)?.because ?? []).join("; "),
        effectiveClass: id === HUMAN_CLASS_STEP ? "ruling" : (taint.classes.get(id) ?? "opinion"),
        outcomes: s.outcomes,
        optional: s.optional,
        ...(w === undefined ? {} : { worlds: w }),
        ...(s.guards === undefined
          ? {}
          : {
              guards: {
                predicate: s.guards.predicate,
                policy: facts.predicatePolicy?.[s.guards.predicate] ?? DEFAULT_PREDICATE_POLICY,
                probe: s.guards.probe,
              },
            }),
      },
    ];
  });
  const costEstimate = planned.reduce(
    (sum, p) => sum + (table.get(p.id)?.budget.usd ?? 0) * Math.max(1, p.worlds?.length ?? 1),
    0,
  );
  const versions = Object.fromEntries(
    planned.flatMap((p) => {
      const version = table.get(p.id)?.version;
      return version === undefined ? [] : [[p.id, version] as const];
    }),
  );
  const overrides = Object.fromEntries(
    planned.map((p) => [p.id, table.get(p.id)?.overrides ?? []]),
  );
  const mayskip = Object.fromEntries(planned.map((p) => [p.id, table.get(p.id)?.mayskip ?? []]));
  const preimage: PlanPreimage = {
    compiler: COMPILER_VERSION,
    baseCommit: facts.baseCommit,
    flow: compiled,
    steps: planned,
    versions,
    overrides,
    mayskip,
    humanClass: touchesFlow.length > 0,
  };
  return Result.succeed({ ...preimage, planHash: planHashOf(preimage), costEstimate });
};
