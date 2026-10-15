import { Result, Schema } from "effect";
import { type ChangeId, canBlock, type ContentHash, weakest } from "../kernel/index.ts";
import type { World } from "./conflict.ts";
import { UnknownVerdictVersion } from "./errors.ts";
import type { Condition, Flow, FlowPlan } from "./flow.ts";
import type { PlanStep, StepOutcome, StepResult, VerdictOutcome } from "./plan.ts";

/**
 * Why a runner gave no usable answer. Each becomes `abstain`, never a skip, a
 * pass or a fail. `no-runner` is a step no runner here can run (a plan that
 * names a runner this verifier lacks, a world a lane has none of, a deploy
 * with no deploy runner): a gap in the plan or a bug, never capacity, so a
 * park on it is counted, where an `unavailable` box may be waited for.
 */
export const InfraFailure = Schema.Literals([
  "timeout",
  "rate-limited",
  "schema",
  "truncated",
  "unavailable",
  "no-runner",
]);
export type InfraFailure = typeof InfraFailure.Type;

/** What a runner or plugin reports, before Keel trusts it: the outcome may be anything. */
export type StepReport = Omit<StepResult, "outcome"> & {
  readonly outcome: string;
  readonly failure?: InfraFailure;
};

const isOutcome = (step: PlanStep, outcome: string): outcome is StepOutcome =>
  (step.outcomes ?? []).some((o) => o === outcome);

/**
 * Turns a report into a result the verdict can use. Infra failures, outcomes
 * the step did not declare, and pass or fail from evidence too weak to decide
 * all become `abstain`. A report never claims more than the step's effective
 * class; skips and overrides survive only where the plan allows them.
 */
export const coerce = (plan: FlowPlan, report: StepReport): StepResult => {
  const step = plan.steps.find((s) => s.id === report.stepId);
  const ceiling = step?.effectiveClass ?? step?.evidenceCeiling ?? "opinion";
  const evidenceClass = weakest(report.evidenceClass, ceiling);
  const declared = step !== undefined && isOutcome(step, report.outcome);
  const decisive = report.outcome === "pass" || report.outcome === "fail";
  const usable = report.failure === undefined && declared && (!decisive || canBlock(evidenceClass));
  const outcome: StepOutcome =
    usable && step !== undefined && isOutcome(step, report.outcome) ? report.outcome : "abstain";
  const allowedSkips = plan.mayskip[report.stepId] ?? [];
  const allowedOverrides = step?.kind === "human" ? (plan.overrides[report.stepId] ?? []) : [];
  const skips = (report.skips ?? []).filter((s) => allowedSkips.includes(s));
  const overrides = (report.overrides ?? []).filter((s) => allowedOverrides.includes(s));
  const { failure: _failure, ...rest } = report;
  return {
    ...rest,
    outcome,
    evidenceClass,
    ...(skips.length === 0 ? { skips: undefined } : { skips }),
    ...(overrides.length === 0 ? { overrides: undefined } : { overrides }),
  };
};

type Status = "pass" | "pending" | "escalate" | "fail";
const severity: Record<Status, number> = { pass: 0, pending: 1, escalate: 2, fail: 3 };

type Value = {
  readonly status: Status;
  readonly outcome?: StepOutcome;
  readonly evidence: readonly StepResult[];
  readonly waiting: readonly string[];
  /** Guard fails the project's policy turned into advice: every one met, whatever the status. */
  readonly advisories: readonly StepResult[];
};

const pass: Value = { status: "pass", evidence: [], waiting: [], advisories: [] };

const combine = (values: readonly Value[]): Value => {
  const worst = values.reduce<Status>(
    (w, v) => (severity[v.status] > severity[w] ? v.status : w),
    "pass",
  );
  const at = values.filter((v) => v.status === worst);
  return {
    status: worst,
    evidence: at.flatMap((v) => v.evidence),
    waiting: values.flatMap((v) => v.waiting),
    advisories: values.flatMap((v) => v.advisories),
  };
};

const resultKey = (step: string, world: World | undefined): string => `${step}@${world ?? ""}`;

const rank = (r: StepResult): number =>
  ({ pass: 0, annotate: 0, abstain: 1, escalate: 2, fail: 3 })[r.outcome];

/** The more severe of two results, with a total tiebreak, so arrival order never matters. */
const severer = (a: StepResult, b: StepResult): StepResult =>
  rank(a) !== rank(b)
    ? rank(a) > rank(b)
      ? a
      : b
    : JSON.stringify(a) >= JSON.stringify(b)
      ? a
      : b;

/** One result per step and world; if a runner reported twice, the more severe counts. */
const index = (results: readonly StepResult[]): ReadonlyMap<string, StepResult> => {
  const map = new Map<string, StepResult>();
  for (const r of results) {
    const k = resultKey(r.stepId, r.world);
    const seen = map.get(k);
    map.set(k, seen === undefined ? r : severer(seen, r));
  }
  return map;
};

type Context = {
  readonly plan: FlowPlan;
  readonly steps: ReadonlyMap<string, PlanStep>;
  readonly results: ReadonlyMap<string, StepResult>;
  readonly overridden: ReadonlySet<string>;
};

const leaf = (ctx: Context, id: string, world: World | undefined): Value => {
  const step = ctx.steps.get(id);
  const optional = step?.optional === true;
  const r = ctx.results.get(resultKey(id, world));
  if (r === undefined)
    return optional ? pass : { status: "pending", evidence: [], waiting: [id], advisories: [] };
  const as = (status: Status): Value => ({
    status,
    outcome: r.outcome,
    evidence: [r],
    waiting: [],
    advisories: [],
  });
  // A tenet never blocks by itself: its guard's fail, or its abstain (an n/a
  // means the tenet's precondition is gone from the candidate, a silent
  // retraction), stops the flow only where the project chose block. Otherwise
  // the flow reads the step as a pass (a cascade accepts it), and the result
  // is kept as advice.
  const advised = step?.guards !== undefined && step.guards.policy !== "block";
  const advice: Value = { ...as("pass"), outcome: "pass", advisories: [r] };
  switch (r.outcome) {
    case "pass":
    case "annotate":
      return as("pass");
    case "fail":
      if (!canBlock(r.evidenceClass)) return as("escalate");
      if (ctx.overridden.has(id)) return as("pass");
      return advised ? advice : as("fail");
    case "escalate":
      return as("escalate");
    default:
      if (advised) return advice;
      return optional ? as("pass") : as("escalate");
  }
};

const holds = (ctx: Context, c: Condition, world: World | undefined): boolean | "unknown" => {
  switch (c._tag) {
    case "outcome": {
      const anyWorld = [...ctx.results.values()]
        .filter((x) => x.stepId === c.step)
        .reduce<StepResult | undefined>(
          (worst, x) => (worst === undefined ? x : severer(worst, x)),
          undefined,
        );
      const r = ctx.results.get(resultKey(c.step, world)) ?? anyWorld;
      return r === undefined ? "unknown" : c.in.includes(r.outcome);
    }
    case "not": {
      const v = holds(ctx, c.item, world);
      return v === "unknown" ? v : !v;
    }
    case "and": {
      const vs = c.items.map((i) => holds(ctx, i, world));
      return vs.includes(false) ? false : vs.includes("unknown") ? "unknown" : true;
    }
    default: {
      const vs = c.items.map((i) => holds(ctx, i, world));
      return vs.includes(true) ? true : vs.includes("unknown") ? "unknown" : false;
    }
  }
};

const statusOutcome = (v: Value): StepOutcome =>
  v.outcome ?? (v.status === "fail" ? "fail" : v.status === "escalate" ? "escalate" : "pass");

const evaluate = (ctx: Context, flow: Flow, world: World | undefined): Value => {
  switch (flow._tag) {
    case "step":
      return leaf(ctx, flow.step, world);
    case "seq": {
      const values: Value[] = [];
      for (const item of flow.items) {
        const v = evaluate(ctx, item, world);
        values.push(v);
        if (v.status === "fail") break;
      }
      return combine(values);
    }
    case "par":
      return combine(flow.items.map((i) => evaluate(ctx, i, world)));
    case "cascade": {
      const advisories: StepResult[] = [];
      for (const item of flow.items) {
        const v = evaluate(ctx, item, world);
        advisories.push(...v.advisories);
        if (v.status === "pending" || flow.accept.includes(statusOutcome(v)))
          return { ...v, advisories };
      }
      return { status: "escalate", evidence: [], waiting: [], advisories };
    }
    case "worlds":
      return combine(flow.over.map((w) => evaluate(ctx, flow.body, w)));
    case "when": {
      const v = holds(ctx, flow.condition, world);
      if (v === "unknown") return { status: "pending", evidence: [], waiting: [], advisories: [] };
      return v ? evaluate(ctx, flow.body, world) : pass;
    }
    default:
      return evaluate(ctx, flow.body, world);
  }
};

export const VERDICT_VERSIONS = ["verdict/1"] as const;
export type VerdictVersion = (typeof VERDICT_VERSIONS)[number];

export type Verdict = {
  readonly outcome: VerdictOutcome;
  readonly version: VerdictVersion;
  readonly planHash: ContentHash;
  /** The results the outcome rests on: the fails for a bounce, the escalations for a park, everything for a land. */
  readonly evidence: readonly StepResult[];
  /** Required steps with no result yet, for a hold. */
  readonly waitingOn: readonly string[];
  /**
   * Guard fails that did not fail the verdict, because the project's policy
   * for the guard's predicate is advise or annotate: lanes warn from them.
   */
  readonly advisories: readonly StepResult[];
};

export type Run = { readonly results: readonly StepResult[]; readonly supersededBy?: ChangeId };

const verdict1 = (plan: FlowPlan, run: Run): Verdict => {
  const steps = new Map(plan.steps.map((s) => [s.id, s]));
  const overridden = new Set(
    run.results
      .filter((r) => steps.get(r.stepId)?.kind === "human")
      .flatMap((r) => r.overrides ?? []),
  );
  const ctx: Context = { plan, steps, results: index(run.results), overridden };
  const base = { version: "verdict/1" as const, planHash: plan.planHash };
  if (run.supersededBy !== undefined)
    return { ...base, outcome: "supersede", evidence: [], waitingOn: [], advisories: [] };
  const root = evaluate(ctx, plan.flow, undefined);
  const outcome: VerdictOutcome =
    root.status === "fail"
      ? "bounce"
      : root.status === "escalate"
        ? "park"
        : root.status === "pending"
          ? "hold"
          : "land";
  return {
    ...base,
    outcome,
    evidence: root.evidence,
    waitingOn: [...new Set(root.waiting)].toSorted(),
    advisories: root.advisories,
  };
};

/**
 * The verdict on a change: a versioned, pure function of its plan and its
 * step results. Supersede beats everything; a fail from proof or a ruling,
 * not overridden by a person, bounces; an escalation (including an abstain on
 * a required step) parks for a ruling; a missing result holds; otherwise the
 * change lands.
 */
export const verdict = (
  plan: FlowPlan,
  run: Run,
  version: string,
): Result.Result<Verdict, UnknownVerdictVersion> =>
  version === "verdict/1"
    ? Result.succeed(verdict1(plan, run))
    : Result.fail(new UnknownVerdictVersion({ version }));
