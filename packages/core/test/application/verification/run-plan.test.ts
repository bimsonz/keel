import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { runPlan, type StepRunner } from "../../../src/application/verification/index.ts";
import { canBlock, contentHashOf } from "../../../src/domain/kernel/index.ts";
import {
  coerce,
  compile,
  type Flow,
  type FlowPlan,
  type FlowWorld,
  type PlanStep,
  type StepReport,
  type StepSpec,
  verdict,
} from "../../../src/domain/verification/index.ts";
import { base, emptyDefaults, type FlowCase, flowCaseArb } from "../../arbitraries/flow.ts";
import { fc } from "../../support/fast-check.ts";

const planOf = (c: FlowCase): FlowPlan =>
  Result.getOrThrow(compile(c.spec, c.facts, emptyDefaults));

/** A hand-written plan: the steps and the flow, compiled from the base with no facts. */
const handPlan = (steps: readonly StepSpec[], flow: Flow): FlowPlan =>
  Result.getOrThrow(
    compile(
      { commit: base, flow, steps },
      { baseCommit: base, touchedPaths: ["src/a.ts"], subjects: [], facts: {} },
      emptyDefaults,
    ),
  );

const proofStep = (id: string, extra: Partial<StepSpec> = {}): StepSpec => ({
  id,
  version: contentHashOf({ id }),
  kind: "deterministic",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0, cpuMs: 1000, tokens: 0 },
  determinism: "deterministic",
  suite: true,
  optional: false,
  ...extra,
});

const leaf = (step: string): Flow => ({ _tag: "step", step });
const seq = (...items: Flow[]): Flow => ({ _tag: "seq", exitOn: "fail", items });

const OUTCOMES = ["pass", "fail", "escalate", "annotate", "abstain"] as const;

/** FNV-1a, so a scripted runner answers the same for the same step and world. */
const hash = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

const report = (
  step: PlanStep,
  world: FlowWorld | undefined,
  outcome: string,
  extra: Partial<StepReport> = {},
): StepReport => ({
  stepId: step.id,
  outcome,
  evidenceClass: step.evidenceCeiling,
  tier: step.tier,
  durationMs: 0,
  ...(world === undefined ? {} : { world }),
  ...extra,
});

/** A deterministic runner: each step and world answers one of every outcome, declared or not. */
const scripted =
  (salt: number): StepRunner<never> =>
  (step, world) =>
    Effect.succeed(
      report(
        step,
        world,
        OUTCOMES[hash(`${salt}:${step.id}@${world ?? ""}`) % OUTCOMES.length] ?? "pass",
      ),
    );

/** Records every call, so a test can see what ran and in what order. */
const recording = (answer: (step: PlanStep, world: FlowWorld | undefined) => StepReport) => {
  const calls: string[] = [];
  const runner: StepRunner<never> = (step, world) =>
    Effect.sync(() => {
      calls.push(world === undefined ? step.id : `${step.id}@${world}`);
      return answer(step, world);
    });
  return { calls, runner };
};

const run = (plan: FlowPlan, runner: StepRunner<never>) => Effect.runPromise(runPlan(plan, runner));

/** Every step of the plan, run in every world it names: what a runner without a flow would do. */
const runAll = (plan: FlowPlan, runner: StepRunner<never>) =>
  Effect.runPromise(
    Effect.forEach(plan.steps, (step) =>
      Effect.forEach(step.worlds ?? [undefined], (world) => runner(step, world)),
    ).pipe(Effect.map((rows) => rows.flat())),
  );

const verdictOn = (plan: FlowPlan, reports: readonly StepReport[]) =>
  Result.getOrThrow(verdict(plan, { results: reports.map((r) => coerce(plan, r)) }, "verdict/1"));

/** A step's result blocks a seq: a fail from proof or a ruling that no human step has overridden. */
const blocks = (plan: FlowPlan, r: StepReport, overridden: ReadonlySet<string>): boolean => {
  const c = coerce(plan, r);
  return c.outcome === "fail" && canBlock(c.evidenceClass) && !overridden.has(c.stepId);
};

const stepsUnder = (flow: Flow): string[] => {
  switch (flow._tag) {
    case "step":
      return [flow.step];
    case "seq":
    case "par":
    case "cascade":
      return flow.items.flatMap(stepsUnder);
    default:
      return stepsUnder(flow.body);
  }
};

describe("run-plan: the compiled plan's flow, executed", () => {
  it("[run-plan.verdict-as-if-all-ran] running the flow gives the verdict running every step would", async () => {
    await fc.assert(
      fc.asyncProperty(flowCaseArb(), fc.nat(), async (c, salt) => {
        const plan = planOf(c);
        const runner = scripted(salt);
        const ran = await run(plan, runner);
        const all = await runAll(plan, runner);
        expect(verdictOn(plan, ran)).toEqual(verdictOn(plan, all));
      }),
    );
  });

  it("[run-plan.once] no step runs twice in one world", async () => {
    await fc.assert(
      fc.asyncProperty(flowCaseArb(), fc.nat(), async (c, salt) => {
        const plan = planOf(c);
        const ran = await run(plan, scripted(salt));
        const keys = ran.map((r) => `${r.stepId}@${r.world ?? ""}`);
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it("[run-plan.shared-once] a step a union shares between branches runs once, and every branch reads that result", async () => {
    await fc.assert(
      fc.asyncProperty(flowCaseArb(), fc.nat(), async (c, salt) => {
        const member = planOf(c);
        // A union is a par of the member flows, steps deduplicated by id: here, a plan with itself.
        const union: FlowPlan = {
          ...member,
          flow: { _tag: "par", items: [member.flow, member.flow] },
        };
        const answer = scripted(salt);
        const calls: string[] = [];
        // The runner yields, so the two branches really interleave.
        const runner: StepRunner<never> = (step, world) =>
          Effect.yieldNow.pipe(
            Effect.tap(() => Effect.sync(() => calls.push(`${step.id}@${world ?? ""}`))),
            Effect.andThen(answer(step, world)),
          );
        const ran = await run(union, runner);
        expect(calls.toSorted((a, b) => a.localeCompare(b))).toEqual(
          [...new Set(calls)].toSorted((a, b) => a.localeCompare(b)),
        );
        expect(verdictOn(union, ran).outcome).toBe(
          verdictOn(member, await run(member, answer)).outcome,
        );
      }),
    );
  });

  it("[run-plan.seq-stops] nothing after a seq item that blocks runs", async () => {
    await fc.assert(
      fc.asyncProperty(flowCaseArb({ shapes: ["step"] }), fc.nat(), async (c, salt) => {
        const plan = planOf(c);
        const ran = await run(plan, scripted(salt));
        const root = plan.flow;
        if (root._tag !== "seq") return;
        const overridden = new Set(ran.flatMap((r) => coerce(plan, r).overrides ?? []));
        const byStep = new Map(ran.map((r) => [r.stepId, r]));
        const firstBlock = root.items.findIndex((item) => {
          if (item._tag !== "step") return false;
          const r = byStep.get(item.step);
          return r !== undefined && blocks(plan, r, overridden);
        });
        if (firstBlock === -1) return;
        const after = new Set(root.items.slice(firstBlock + 1).flatMap(stepsUnder));
        expect(ran.filter((r) => after.has(r.stepId))).toEqual([]);
      }),
    );
    const { calls, runner } = recording((s, w) => report(s, w, s.id === "a" ? "fail" : "pass"));
    await run(handPlan([proofStep("a"), proofStep("b")], seq(leaf("a"), leaf("b"))), runner);
    expect(calls).toEqual(["a"]);
  });

  it("[run-plan.seq-in-order] a seq runs its items one after another, in order", async () => {
    const { calls, runner } = recording((s, w) => report(s, w, "pass"));
    await run(
      handPlan(
        [proofStep("a"), proofStep("b"), proofStep("c")],
        seq(leaf("a"), leaf("b"), leaf("c")),
      ),
      runner,
    );
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("[run-plan.override-asked] a seq goes on past a fail a later human step may override, so the person is asked", async () => {
    const human = proofStep("h", {
      kind: "human",
      evidenceCeiling: "ruling",
      outcomes: ["pass", "fail", "abstain"],
      overrides: ["a"],
      suite: false,
    });
    const plan = handPlan([proofStep("a"), human], seq(leaf("a"), leaf("h")));
    const overriding = recording((s, w) =>
      s.id === "a" ? report(s, w, "fail") : report(s, w, "pass", { overrides: ["a"] }),
    );
    const ran = await run(plan, overriding.runner);
    expect(overriding.calls).toEqual(["a", "h"]);
    expect(verdictOn(plan, ran).outcome).toBe("land");
    const declining = recording((s, w) => report(s, w, s.id === "a" ? "fail" : "pass"));
    expect(verdictOn(plan, await run(plan, declining.runner)).outcome).toBe("bounce");
  });

  it("[run-plan.cascade-stops] a cascade stops at the first item whose outcome it accepts", async () => {
    const steps = [proofStep("a"), proofStep("b"), proofStep("c")];
    const flow: Flow = {
      _tag: "cascade",
      accept: ["pass"],
      items: [leaf("a"), leaf("b"), leaf("c")],
    };
    const first = recording((s, w) => report(s, w, s.id === "a" ? "abstain" : "pass"));
    await run(handPlan(steps, flow), first.runner);
    expect(first.calls).toEqual(["a", "b"]);
    const none = recording((s, w) => report(s, w, "abstain"));
    const ran = await run(handPlan(steps, flow), none.runner);
    expect(none.calls).toEqual(["a", "b", "c"]);
    expect(verdictOn(handPlan(steps, flow), ran).outcome).toBe("park");
  });

  it("[run-plan.when] a when runs its body only if its condition holds over what already ran", async () => {
    const steps = [proofStep("a"), proofStep("b")];
    const flow = seq(leaf("a"), {
      _tag: "when",
      condition: { _tag: "outcome", step: "a", in: ["abstain"] },
      body: leaf("b"),
    });
    const holds = recording((s, w) => report(s, w, s.id === "a" ? "abstain" : "pass"));
    await run(handPlan(steps, flow), holds.runner);
    expect(holds.calls).toEqual(["a", "b"]);
    const fails = recording((s, w) => report(s, w, "pass"));
    await run(handPlan(steps, flow), fails.runner);
    expect(fails.calls).toEqual(["a"]);
  });

  it("[run-plan.worlds] a step under worlds runs once in each world, told which", async () => {
    const plan = handPlan([proofStep("probe", { worlds: ["trunk", "A", "B", "AB"] })], {
      _tag: "worlds",
      over: ["trunk", "A", "B", "AB"],
      body: leaf("probe"),
    });
    const { calls, runner } = recording((s, w) => report(s, w, "pass"));
    const ran = await run(plan, runner);
    expect(calls.toSorted()).toEqual(["probe@A", "probe@AB", "probe@B", "probe@trunk"]);
    expect(ran.map((r) => r.world ?? "").toSorted((a, b) => a.localeCompare(b))).toEqual([
      "A",
      "AB",
      "B",
      "trunk",
    ]);
  });

  it("[run-plan.skips] a step skipped by an allowed skip never runs; a disallowed skip is ignored", async () => {
    const opinion = proofStep("o", {
      kind: "decision-model",
      evidenceCeiling: "opinion",
      outcomes: ["annotate", "abstain"],
      mayskip: ["slow"],
      suite: false,
    });
    const steps = [opinion, proofStep("slow", { optional: true }), proofStep("must")];
    const flow = seq(leaf("o"), leaf("slow"), leaf("must"));
    const skipping = recording((s, w) =>
      report(
        s,
        w,
        s.id === "o" ? "annotate" : "pass",
        s.id === "o" ? { skips: ["slow", "must"] } : {},
      ),
    );
    const ran = await run(handPlan(steps, flow), skipping.runner);
    expect(skipping.calls).toEqual(["o", "must"]);
    expect(verdictOn(handPlan(steps, flow), ran).outcome).toBe("land");
  });

  it("[run-plan.budget] once a budget's body has spent its limit, the rest of it abstains unrun", async () => {
    const steps = [proofStep("a"), proofStep("b"), proofStep("c")];
    const flow = seq(
      {
        _tag: "budget",
        limit: { usd: 1, cpuMs: 1000, tokens: 0 },
        onExhaust: "escalate",
        body: seq(leaf("a"), leaf("b")),
      },
      leaf("c"),
    );
    const { calls, runner } = recording((s, w) => report(s, w, "pass", { durationMs: 1500 }));
    const plan = handPlan(steps, flow);
    const ran = await run(plan, runner);
    expect(calls).toEqual(["a", "c"]);
    expect(ran.find((r) => r.stepId === "b")?.outcome).toBe("abstain");
    expect(verdictOn(plan, ran).outcome).toBe("park");
  });

  it("[run-plan.asked-step] a report counts for the step and world it was asked for, whatever it claims", async () => {
    const plan = handPlan([proofStep("a"), proofStep("b")], seq(leaf("a"), leaf("b")));
    const { runner } = recording((s, w) =>
      report(s, w, s.id === "a" ? "pass" : "fail", { stepId: "a", world: "AB" }),
    );
    const ran = await run(plan, runner);
    expect(ran.map((r) => [r.stepId, r.world])).toEqual([
      ["a", undefined],
      ["b", undefined],
    ]);
    expect(verdictOn(plan, ran).outcome).toBe("bounce");
  });

  it("[run-plan.flow-order] reports come back in the flow's order, whatever order the runner finished in", async () => {
    const plan = handPlan([proofStep("a"), proofStep("b"), proofStep("c")], {
      _tag: "par",
      items: [leaf("a"), leaf("b"), leaf("c")],
    });
    const delays: Record<string, number> = { a: 30, b: 0, c: 15 };
    const runner: StepRunner<never> = (s, w) =>
      Effect.sleep(delays[s.id] ?? 0).pipe(Effect.as(report(s, w, "pass")));
    const ran = await run(plan, runner);
    expect(ran.map((r) => r.stepId)).toEqual(["a", "b", "c"]);
  });
});
