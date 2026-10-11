import { Deferred, Effect } from "effect";
import { canBlock } from "../../domain/kernel/index.ts";
import {
  type Budget,
  type Condition,
  coerce,
  type Flow,
  type FlowPlan,
  type FlowWorld,
  type PlanStep,
  type StepOutcome,
  type StepReport,
  type StepResult,
} from "../../domain/verification/index.ts";

/** Runs one step of the plan in one world (none outside a `worlds` node) and reports what happened. */
export type StepRunner<R> = (
  step: PlanStep,
  world: FlowWorld | undefined,
) => Effect.Effect<StepReport, never, R>;

type Status = "pass" | "pending" | "escalate" | "fail";
const severity: Record<Status, number> = { pass: 0, pending: 1, escalate: 2, fail: 3 };

/**
 * A node's standing once it has run, as `verdict/1` would judge it. A fail is
 * `overridable` while a human step that may override it has yet to run: a seq
 * must go on past it, or the person is never asked.
 */
type Value = {
  readonly status: Status;
  readonly outcome?: StepOutcome;
  readonly overridable?: boolean;
};

const PASS: Value = { status: "pass" };
const PENDING: Value = { status: "pending" };

const keyOf = (step: string, world: FlowWorld | undefined) => `${step}@${world ?? ""}`;

/** What a budget node's body has spent so far. Only time is reported by runners today. */
type Account = { readonly limit: Budget; spentMs: number };

type State = {
  readonly plan: FlowPlan;
  readonly steps: ReadonlyMap<string, PlanStep>;
  readonly reports: Map<string, StepReport>;
  readonly results: Map<string, StepResult>;
  readonly skipped: Set<string>;
  readonly overridden: Set<string>;
  /** Steps started and not yet reported: a branch that reaches one waits for its result. */
  readonly running: Map<string, Deferred.Deferred<StepResult>>;
};

const combine = (values: readonly Value[]): Value => {
  const worst = values.reduce<Status>(
    (w, v) => (severity[v.status] > severity[w] ? v.status : w),
    "pass",
  );
  return worst === "fail"
    ? {
        status: worst,
        overridable: values.filter((v) => v.status === "fail").every((v) => v.overridable === true),
      }
    : { status: worst };
};

const statusOutcome = (v: Value): StepOutcome =>
  v.outcome ?? (v.status === "fail" ? "fail" : v.status === "escalate" ? "escalate" : "pass");

const rank = (r: StepResult): number =>
  ({ pass: 0, annotate: 0, abstain: 1, escalate: 2, fail: 3 })[r.outcome];

const severer = (a: StepResult, b: StepResult): StepResult =>
  rank(a) !== rank(b)
    ? rank(a) > rank(b)
      ? a
      : b
    : JSON.stringify(a) >= JSON.stringify(b)
      ? a
      : b;

/** The steps a condition reads. */
const conditionSteps = (c: Condition): string[] => {
  switch (c._tag) {
    case "outcome":
      return [c.step];
    case "not":
      return conditionSteps(c.item);
    default:
      return c.items.flatMap(conditionSteps);
  }
};

/** A condition over what has run so far: the same reading `verdict/1` gives it. */
const holds = (s: State, c: Condition, world: FlowWorld | undefined): boolean | "unknown" => {
  switch (c._tag) {
    case "outcome": {
      const anyWorld = [...s.results.values()]
        .filter((r) => r.stepId === c.step)
        .reduce<StepResult | undefined>((w, r) => (w === undefined ? r : severer(w, r)), undefined);
      const r = s.results.get(keyOf(c.step, world)) ?? anyWorld;
      return r === undefined ? "unknown" : c.in.includes(r.outcome);
    }
    case "not": {
      const v = holds(s, c.item, world);
      return v === "unknown" ? v : !v;
    }
    case "and": {
      const vs = c.items.map((i) => holds(s, i, world));
      return vs.includes(false) ? false : vs.includes("unknown") ? "unknown" : true;
    }
    default: {
      const vs = c.items.map((i) => holds(s, i, world));
      return vs.includes(true) ? true : vs.includes("unknown") ? "unknown" : false;
    }
  }
};

const valueOf = (s: State, step: PlanStep, r: StepResult): Value => {
  switch (r.outcome) {
    case "pass":
    case "annotate":
      return { status: "pass", outcome: r.outcome };
    case "fail": {
      if (!canBlock(r.evidenceClass)) return { status: "escalate", outcome: r.outcome };
      if (s.overridden.has(step.id)) return { status: "pass", outcome: r.outcome };
      const overriders = Object.entries(s.plan.overrides)
        .filter(([id, targets]) => s.steps.get(id)?.kind === "human" && targets.includes(step.id))
        .map(([id]) => id);
      const pending = overriders.some(
        (id) => ![...s.results.values()].some((x) => x.stepId === id),
      );
      return { status: "fail", outcome: r.outcome, overridable: pending };
    }
    case "escalate":
      return { status: "escalate", outcome: r.outcome };
    default:
      return step.optional
        ? { status: "pass", outcome: r.outcome }
        : { status: "escalate", outcome: r.outcome };
  }
};

/** A step a spent budget never ran: it abstains, which parks the change unless the step is optional. */
const unrun = (step: PlanStep, world: FlowWorld | undefined): StepReport => ({
  stepId: step.id,
  outcome: "abstain",
  evidenceClass: step.evidenceCeiling,
  tier: step.tier,
  durationMs: 0,
  ...(world === undefined ? {} : { world }),
});

const evaluate = <R>(
  s: State,
  runner: StepRunner<R>,
  flow: Flow,
  world: FlowWorld | undefined,
  accounts: readonly Account[],
): Effect.Effect<Value, never, R> => {
  switch (flow._tag) {
    case "step": {
      const step = s.steps.get(flow.step);
      if (step === undefined) return Effect.succeed(PENDING);
      const key = keyOf(step.id, world);
      const seen = s.results.get(key);
      if (seen !== undefined) return Effect.succeed(valueOf(s, step, seen));
      // A union shares steps between its members' branches: a step runs once, and every branch reads it.
      const running = s.running.get(key);
      if (running !== undefined)
        return Deferred.await(running).pipe(Effect.map((r) => valueOf(s, step, r)));
      // Only optional steps can be skipped (coerce drops any other skip), and verdict/1 passes them.
      if (s.skipped.has(step.id)) return Effect.succeed(PASS);
      const started = Deferred.makeUnsafe<StepResult>();
      s.running.set(key, started);
      const spent = accounts.some((a) => a.spentMs > a.limit.cpuMs);
      return (spent ? Effect.succeed(unrun(step, world)) : runner(step, world)).pipe(
        Effect.flatMap((reported) => {
          // The step and world are the ones asked for, whatever the runner wrote.
          const { world: _world, ...rest } = reported;
          const report: StepReport = {
            ...rest,
            stepId: step.id,
            ...(world === undefined ? {} : { world }),
          };
          const result = coerce(s.plan, report);
          s.reports.set(key, report);
          s.results.set(key, result);
          for (const skipped of result.skips ?? []) s.skipped.add(skipped);
          for (const overridden of result.overrides ?? []) s.overridden.add(overridden);
          for (const a of accounts) a.spentMs += report.durationMs;
          s.running.delete(key);
          return Deferred.succeed(started, result).pipe(Effect.as(valueOf(s, step, result)));
        }),
      );
    }
    case "seq":
      return Effect.gen(function* () {
        const values: Value[] = [];
        for (const item of flow.items) {
          const v = yield* evaluate(s, runner, item, world, accounts);
          values.push(v);
          if (v.status === "fail" && v.overridable !== true) break;
        }
        return combine(values);
      });
    case "par":
      return Effect.all(
        flow.items.map((item) => evaluate(s, runner, item, world, accounts)),
        { concurrency: "unbounded" },
      ).pipe(Effect.map(combine));
    case "cascade":
      return Effect.gen(function* () {
        for (const item of flow.items) {
          const v = yield* evaluate(s, runner, item, world, accounts);
          if (v.status === "pending") return v;
          if (flow.accept.includes(statusOutcome(v))) return v;
        }
        return { status: "escalate" } satisfies Value;
      });
    case "worlds":
      return Effect.all(
        flow.over.map((w) => evaluate(s, runner, flow.body, w, accounts)),
        { concurrency: "unbounded" },
      ).pipe(Effect.map(combine));
    case "when": {
      // A step the condition reads may not have run (a cascade stopped short of it): run it now,
      // in each world it runs in, so the condition reads what verdict/1 reads.
      const demanded = conditionSteps(flow.condition).flatMap((id) =>
        (s.steps.get(id)?.worlds ?? [undefined]).map(
          (w) => () => evaluate(s, runner, { _tag: "step", step: id }, w, accounts),
        ),
      );
      return Effect.forEach(demanded, (run) => run(), { discard: true }).pipe(
        Effect.flatMap(() => {
          const v = holds(s, flow.condition, world);
          if (v === "unknown") return Effect.succeed(PENDING);
          return v ? evaluate(s, runner, flow.body, world, accounts) : Effect.succeed(PASS);
        }),
      );
    }
    default:
      return evaluate(s, runner, flow.body, world, [
        ...accounts,
        { limit: flow.limit, spentMs: 0 },
      ]);
  }
};

/** Every step and world the flow can reach, depth first, in the flow's own order. */
const order = (flow: Flow, world: FlowWorld | undefined): string[] => {
  switch (flow._tag) {
    case "step":
      return [keyOf(flow.step, world)];
    case "seq":
    case "par":
    case "cascade":
      return flow.items.flatMap((item) => order(item, world));
    case "worlds":
      return flow.over.flatMap((w) => order(flow.body, w));
    default:
      return order(flow.body, world);
  }
};

/**
 * Runs a compiled plan's flow, reaching exactly the steps `verdict/1` reads:
 * a seq stops at a blocking fail, unless a human step that may override it is
 * still to run; par and worlds run every item at once; a cascade stops at the
 * first outcome it accepts; a when first runs any step its condition reads
 * that has not run, then runs its body only if the condition holds; a step an
 * earlier result skipped (and was allowed to) never runs. A step a union
 * shares between branches runs once, and every branch reads its result. Once
 * a budget's body has spent more time than its limit, its remaining steps
 * abstain unrun, so the change parks. Each step runs at most once per world,
 * and the reports come back in the flow's order.
 */
export const runPlan = <R>(
  plan: FlowPlan,
  runner: StepRunner<R>,
): Effect.Effect<readonly StepReport[], never, R> => {
  const s: State = {
    plan,
    steps: new Map(plan.steps.map((step) => [step.id, step])),
    reports: new Map(),
    results: new Map(),
    skipped: new Set(),
    overridden: new Set(),
    running: new Map(),
  };
  return evaluate(s, runner, plan.flow, undefined, []).pipe(
    Effect.map(() =>
      [...new Set(order(plan.flow, undefined))].flatMap((key) => {
        const report = s.reports.get(key);
        return report === undefined ? [] : [report];
      }),
    ),
  );
};
