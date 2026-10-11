import { describe, expect, it } from "@effect/vitest";
import {
  candidateRunner,
  type DurableReport,
  readStoredPlan,
  resolvePlan,
  runPlan,
  settleUnresolved,
} from "@keeltown/core/application/verification";
import type { FlowPlan, VerificationJob } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { PlanStore } from "@keeltown/core/ports";
import {
  freshId,
  makeEvidenceStoreMemory,
  makeIdsMemory,
  makePlanStoreMemory,
  makeProbeRunnerMemory,
  makeVerifierRuntimeMemory,
  guardedPlan,
  TEST_GUARD,
  workerAppPlan,
} from "@keeltown/testing";
import { Effect, Layer, Result, Schema } from "effect";

const hash = (c: string) => Schema.decodeUnknownSync(ContentHash)(`sha256:${c.repeat(64)}`);
const PROBE = TEST_GUARD.probe;
const CANDIDATE = hash("c");

const job: Omit<VerificationJob, "steps"> = {
  jobId: "job-1",
  bundle: CANDIDATE,
  fence: { batchId: freshId("bat"), attempt: 1, chainEpoch: 0 },
};

/** A durable step that records its name and runs the report once, as a first run does. */
const recordingDurable = () => {
  const names: string[] = [];
  const durable: DurableReport = (name, report) =>
    Effect.suspend(() => {
      names.push(name);
      return report;
    });
  return { names, durable };
};

const ran = (outcome: "pass" | "fail" | "n/a") => ({
  _tag: "ran" as const,
  outcome,
  reason: `scripted ${outcome}`,
  observations: ["[probe] scripted"],
});

/** Runs the plan on the candidate runner, over memory adapters; reports what each runner was asked. */
const runOn = (plan: FlowPlan, probe: "pass" | "fail") => {
  const runtime = makeVerifierRuntimeMemory();
  const probes = makeProbeRunnerMemory(() => ran(probe));
  const durable = recordingDurable();
  return runPlan(plan, candidateRunner(job, durable.durable)).pipe(
    Effect.provide(Layer.mergeAll(runtime.layer, probes.layer, makeEvidenceStoreMemory().layer)),
    Effect.map((reports) => ({ reports, runtime, probes, durable })),
  );
};

describe("KeelVerify's plan: the compiled plan, resolved and run", () => {
  it.effect(
    "[d21.plan-resolved] resolves the plan stored under the job's hash, and its text reads back as that plan",
    () =>
      Effect.gen(function* () {
        const store = makePlanStoreMemory();
        const plan = guardedPlan();
        const before = yield* resolvePlan(plan.planHash).pipe(Effect.provide(store.layer));
        expect(before).toEqual({
          _tag: "Unresolved",
          why: `plan ${plan.planHash} is not in the plan store`,
        });
        yield* Effect.gen(function* () {
          return yield* (yield* PlanStore).put(plan);
        }).pipe(Effect.provide(store.layer));
        const after = yield* resolvePlan(plan.planHash).pipe(Effect.provide(store.layer));
        if (after._tag !== "Resolved") throw new Error(`unresolved: ${after.why}`);
        expect(Result.getOrThrow(readStoredPlan(plan.planHash, after.text))).toEqual(plan);
      }),
  );

  it.effect(
    "[d21.plan-corrupt-parks] a stored plan that is not the plan it names is unresolved, never run",
    () =>
      Effect.gen(function* () {
        const store = makePlanStoreMemory();
        const plan = guardedPlan();
        const other = workerAppPlan();
        yield* Effect.gen(function* () {
          return yield* (yield* PlanStore).put(other);
        }).pipe(Effect.provide(store.layer));
        // Another plan's text, filed under this plan's hash.
        yield* store.plant(plan.planHash, store.plans.get(other.planHash) ?? "");
        const resolved = yield* resolvePlan(plan.planHash).pipe(Effect.provide(store.layer));
        expect(resolved._tag).toBe("Unresolved");
        expect(resolved._tag === "Unresolved" && resolved.why).toContain("stored corrupt");
      }),
  );

  it.effect(
    "[d21.plan-missing-parks] an unresolved plan settles park on the job's hash, with resubmit as the remedy",
    () =>
      Effect.gen(function* () {
        const settled = yield* settleUnresolved(PROBE, "plan x is not in the plan store").pipe(
          Effect.provide(makeIdsMemory().layer),
        );
        expect(settled).toMatchObject({
          outcome: "park",
          planHash: PROBE,
          evidence: ["plan: plan x is not in the plan store"],
          failingTests: [],
          nextActions: [expect.objectContaining({ kind: "call", operationId: "submit" })],
        });
      }),
  );

  it.effect(
    "[d21.runs-stored-plan] runs every step of the compiled plan: Tier 2 steps as jobs, the guard through its pinned probe",
    () =>
      Effect.gen(function* () {
        const plan = guardedPlan();
        const { reports, runtime, probes, durable } = yield* runOn(plan, "pass");
        const guard = plan.steps.find((s) => s.guards !== undefined);
        if (guard === undefined)
          throw new Error("the change is exposed to the guard, so compile selects it");
        expect(reports.map((r) => r.stepId).toSorted()).toEqual(
          plan.steps.map((s) => s.id).toSorted(),
        );
        expect(runtime.jobs.map((j) => j.steps.map((s) => s.id))).toEqual(
          plan.steps.filter((s) => s.guards === undefined).map((s) => [s.id]),
        );
        expect(runtime.jobs.every((j) => j.bundle === CANDIDATE)).toBe(true);
        expect(probes.requests).toEqual([
          { probe: PROBE, world: "AB", worldBundle: CANDIDATE, run: 1 },
        ]);
        expect(durable.names).toEqual([`guard ${guard.id}`]);
      }),
  );

  it.effect(
    "[d21.guard-step] a guard step's outcome is its probe's, and it never goes to a Tier 2 runner",
    () =>
      Effect.gen(function* () {
        const plan = guardedPlan();
        const { reports, runtime } = yield* runOn(plan, "fail");
        const guard = reports.find((r) => r.stepId.startsWith("guard:"));
        expect(guard).toMatchObject({
          outcome: "fail",
          tier: { tier: 1, reason: `guards freshness with its admitted probe ${PROBE}` },
        });
        expect(runtime.jobs.flatMap((j) => j.steps).some((s) => s.guards !== undefined)).toBe(
          false,
        );
      }),
  );

  it.effect(
    "[d21.world-unrun] a step asked for a world abstains unrun: a lane verifies one candidate",
    () =>
      Effect.gen(function* () {
        const runtime = makeVerifierRuntimeMemory();
        const probes = makeProbeRunnerMemory(() => ran("pass"));
        const [step] = guardedPlan().steps;
        if (step === undefined) throw new Error("the plan has steps");
        const report = yield* candidateRunner(job, recordingDurable().durable)(step, "A").pipe(
          Effect.provide(
            Layer.mergeAll(runtime.layer, probes.layer, makeEvidenceStoreMemory().layer),
          ),
        );
        expect(report).toMatchObject({ stepId: step.id, outcome: "abstain", world: "A" });
        expect(runtime.jobs).toEqual([]);
        expect(probes.requests).toEqual([]);
      }),
  );
});
