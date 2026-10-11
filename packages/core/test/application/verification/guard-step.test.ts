import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  L1_SUITE_PLAN,
  type ProbeRun,
  type StepRunner,
  withGuards,
} from "../../../src/application/verification/index.ts";
import {
  ProbeRunner,
  ProbeRunnerUnavailable,
  type ProbeRunRequest,
} from "../../../src/application/ports/index.ts";
import { ContentHash } from "../../../src/domain/kernel/index.ts";
import {
  coerce,
  type FlowPlan,
  type PlanStep,
  type StepReport,
} from "../../../src/domain/verification/index.ts";

const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);
const CANDIDATE = hash(7);
const PINNED = hash(42);

const [SUITE] = L1_SUITE_PLAN.steps;
if (SUITE === undefined) throw new Error("L1's plan has a suite step");
/** A guard of freshness, running its admitted probe, under its predicate's advise policy. */
const GUARD: PlanStep = {
  ...SUITE,
  id: "keel.guard.freshness",
  kind: "probe",
  evidenceCeiling: "proof",
  outcomes: ["pass", "fail", "abstain"],
  guards: { predicate: "freshness", policy: "advise", probe: PINNED },
};
const PLAN: FlowPlan = { ...L1_SUITE_PLAN, steps: [GUARD, SUITE] };

/** A runner for every other step: it records that it was asked. */
const otherwise =
  (asked: string[]): StepRunner<never> =>
  (step) =>
    Effect.sync((): StepReport => {
      asked.push(step.id);
      return {
        stepId: step.id,
        outcome: "pass",
        evidenceClass: "proof",
        tier: step.tier,
        durationMs: 0,
      };
    });

function guarded(answer: (r: ProbeRunRequest) => ProbeRun | "unavailable") {
  const requests: ProbeRunRequest[] = [];
  const asked: string[] = [];
  const layer = Layer.succeed(
    ProbeRunner,
    ProbeRunner.of({
      run: (request) =>
        Effect.suspend(() => {
          requests.push(request);
          const a = answer(request);
          return a === "unavailable"
            ? Effect.fail(new ProbeRunnerUnavailable({ reason: "keel-verify did not answer" }))
            : Effect.succeed(a);
        }),
    }),
  );
  const run = (step: PlanStep) =>
    Effect.runPromise(
      withGuards(CANDIDATE, otherwise(asked))(step, undefined).pipe(Effect.provide(layer)),
    );
  return { requests, asked, run };
}

const ran = (outcome: "pass" | "fail" | "n/a"): ProbeRun => ({
  _tag: "ran",
  outcome,
  reason: outcome,
  observations: ["[probe] x"],
});

describe("a guard step runs the probe its plan pins", () => {
  it("[guard.pinned-probe] runs exactly the pinned probe against the candidate, and nothing else", async () => {
    const g = guarded(() => ran("pass"));
    const report = await g.run(GUARD);
    expect(g.requests).toEqual([{ probe: PINNED, world: "AB", worldBundle: CANDIDATE, run: 1 }]);
    expect(report).toMatchObject({
      stepId: GUARD.id,
      outcome: "pass",
      resultRef: PINNED,
      tier: { tier: 1 },
    });
    expect(g.asked).toEqual([]);
  });

  it("[guard.pinned-probe] hands every step that guards nothing to the plan's other runner", async () => {
    const g = guarded(() => ran("pass"));
    await g.run(SUITE);
    expect(g.asked).toEqual([SUITE.id]);
    expect(g.requests).toEqual([]);
  });

  it("[guard.outcomes] reports the probe's pass and fail as they are", async () => {
    const reports = await Promise.all(
      (["pass", "fail"] as const).map((outcome) => guarded(() => ran(outcome)).run(GUARD)),
    );
    expect(reports.map((r) => coerce(PLAN, r).outcome)).toEqual(["pass", "fail"]);
  });

  it("[guard.na-abstains] reports the probe's n/a, which coerce reads as abstain: the tenet's precondition is gone", async () => {
    const report = await guarded(() => ran("n/a")).run(GUARD);
    expect(report.outcome).toBe("n/a");
    expect(coerce(PLAN, report).outcome).toBe("abstain");
  });

  it("[guard.infra-abstains] abstains on a harness error or a runner that could not run, never passing", async () => {
    const harness = await guarded(() => ({
      _tag: "harness-error",
      reason: "two tests",
      observations: [],
    })).run(GUARD);
    const unavailable = await guarded(() => "unavailable").run(GUARD);
    for (const report of [harness, unavailable]) {
      expect(report.failure).toBeDefined();
      expect(coerce(PLAN, report).outcome).toBe("abstain");
    }
    expect(harness.failure).toBe("schema");
    expect(unavailable.failure).toBe("unavailable");
  });
});
