import { describe, expect, it } from "@effect/vitest";
import {
  candidateRunner,
  type DurableReport,
  type DurableTell,
  laneSteps,
  readStoredPlan,
  resolvePlan,
  runPlan,
  settleUnresolved,
  storedPlanText,
} from "@keeltown/core/application/verification";
import type { FlowPlan, VerificationJob } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { PlanStore } from "@keeltown/core/ports";
import {
  freshId,
  makeBatchVerdictsMemory,
  makeEvidenceStoreMemory,
  makeIdsMemory,
  makePlanStoreMemory,
  makeProbeRunnerMemory,
  makeVerifierRuntimeMemory,
  guardedPlan,
  sampleNamespace,
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

/** The deps the candidate's Workflow ensured, which the runner hands on to every Tier 2 job. */
const HANDED = {
  _tag: "DepsReady",
  install: "1".repeat(64),
  parts: [{ sha256: "d".repeat(64), bytes: 10 }],
} as const;

/** Runs the plan on the candidate runner, over memory adapters; reports what each runner was asked. */
const runOn = (plan: FlowPlan, probe: "pass" | "fail") => {
  const runtime = makeVerifierRuntimeMemory();
  const probes = makeProbeRunnerMemory(() => ran(probe));
  const durable = recordingDurable();
  return runPlan(plan, candidateRunner(sampleNamespace, job, durable.durable, HANDED)).pipe(
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
        const before = yield* resolvePlan(sampleNamespace, plan.planHash).pipe(
          Effect.provide(store.layer),
        );
        expect(before).toEqual({
          _tag: "Unresolved",
          why: `plan ${plan.planHash} is not in the plan store`,
        });
        yield* Effect.gen(function* () {
          return yield* (yield* PlanStore).put(sampleNamespace, plan);
        }).pipe(Effect.provide(store.layer));
        const after = yield* resolvePlan(sampleNamespace, plan.planHash).pipe(
          Effect.provide(store.layer),
        );
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
          return yield* (yield* PlanStore).put(sampleNamespace, other);
        }).pipe(Effect.provide(store.layer));
        // Another plan's text, filed under this plan's hash.
        yield* store.plant(
          sampleNamespace,
          plan.planHash,
          Result.getOrThrow(storedPlanText(other)),
        );
        const resolved = yield* resolvePlan(sampleNamespace, plan.planHash).pipe(
          Effect.provide(store.layer),
        );
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
          { namespace: sampleNamespace, probe: PROBE, world: "AB", worldBundle: CANDIDATE, run: 1 },
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
    "[d21.world-unrun] [no-runner.world] a step asked for a world abstains unrun, as no runner's: a lane verifies one candidate",
    () =>
      Effect.gen(function* () {
        const runtime = makeVerifierRuntimeMemory();
        const probes = makeProbeRunnerMemory(() => ran("pass"));
        const [step] = guardedPlan().steps;
        if (step === undefined) throw new Error("the plan has steps");
        const report = yield* candidateRunner(
          sampleNamespace,
          job,
          recordingDurable().durable,
          HANDED,
        )(step, "A").pipe(
          Effect.provide(
            Layer.mergeAll(runtime.layer, probes.layer, makeEvidenceStoreMemory().layer),
          ),
        );
        expect(report).toMatchObject({
          stepId: step.id,
          outcome: "abstain",
          failure: "no-runner",
          world: "A",
        });
        expect(runtime.jobs).toEqual([]);
        expect(probes.requests).toEqual([]);
      }),
  );

  it.effect(
    "[steps.lane-steps] tells the lane of each step in durable steps beside it: its start as the plan has it, its result as the verdict reads it with the runner's failure; a lane that refuses them leaves the run's reports as they were",
    () =>
      Effect.gen(function* () {
        const plan = workerAppPlan();
        const candidateId = freshId("cnd");
        const fence = { ...job.fence, batchId: freshId("bat") };
        const told = { laneId: "lane:prj:main", instanceId: "keel-verify-1", fence, candidateId };
        const names: string[] = [];
        const durable: DurableTell = (name, tell) =>
          Effect.suspend(() => {
            names.push(name);
            return tell;
          });
        const resultRef = `sha256:${"e".repeat(64)}`;
        const runner = (step: (typeof plan.steps)[number]) =>
          Effect.succeed(
            step.id === "js-ts.suite"
              ? {
                  stepId: step.id,
                  outcome: "pass",
                  evidenceClass: step.evidenceCeiling,
                  tier: step.tier,
                  durationMs: 61_250,
                  resultRef,
                }
              : {
                  stepId: step.id,
                  outcome: "pass",
                  failure: "timeout" as const,
                  evidenceClass: step.evidenceCeiling,
                  tier: step.tier,
                  durationMs: 300_000,
                },
          );
        const lane = makeBatchVerdictsMemory(
          new Map([[fence.batchId, { members: [], candidateId, ...fence }]]),
        );
        const reports = yield* runPlan(plan, runner, laneSteps(told, durable)).pipe(
          Effect.provide(lane.layer),
        );
        expect(names.toSorted()).toEqual(
          plan.steps.flatMap((p) => [`finished ${p.id}`, `started ${p.id}`]).toSorted(),
        );
        const ids = plan.steps.map((p) => p.id);
        const sent = lane.steps.map((s) => s.report.step);
        // Each under the instance, so a retried report is the one the lane already holds.
        expect(
          lane.steps.every(
            (s) => s.laneId === told.laneId && s.report.instanceId === told.instanceId,
          ),
        ).toBe(true);
        expect(sent.filter((s) => s._tag === "Started")).toEqual(
          plan.steps.map((p) => ({ _tag: "Started", stepId: p.id, kind: p.kind, tier: p.tier })),
        );
        const finished = (id: string) => sent.find((s) => s._tag === "Finished" && s.stepId === id);
        const suite = plan.steps.find((p) => p.id === "js-ts.suite");
        expect(finished("js-ts.suite")).toEqual({
          _tag: "Finished",
          stepId: "js-ts.suite",
          outcome: "pass",
          evidenceClass: suite?.evidenceCeiling,
          tier: suite?.tier,
          durationMs: 61_250,
          resultRef,
        });
        const other = ids.find((id) => id !== "js-ts.suite") ?? "";
        expect(finished(other)).toMatchObject({
          outcome: "abstain",
          failure: "timeout",
          durationMs: 300_000,
        });
        // A lane that holds no such batch refuses every step: the run reports what it would have.
        const refusing = makeBatchVerdictsMemory();
        expect(
          yield* runPlan(plan, runner, laneSteps(told, durable)).pipe(
            Effect.provide(refusing.layer),
          ),
        ).toEqual(reports);
        expect(refusing.steps).toEqual([]);
      }),
  );

  it.effect(
    "[flow-ruling.gate-passes] the human-class gate passes as the ruling it was resumed by, in no box and no probe",
    () =>
      Effect.gen(function* () {
        const runtime = makeVerifierRuntimeMemory();
        const probes = makeProbeRunnerMemory(() => ran("fail"));
        const durable = recordingDurable();
        const [step] = workerAppPlan().steps;
        if (step === undefined) throw new Error("the plan has steps");
        const gate = { ...step, id: "keel.human-class", kind: "human" as const };
        const report = yield* candidateRunner(
          sampleNamespace,
          job,
          durable.durable,
          HANDED,
        )(gate, undefined).pipe(
          Effect.provide(
            Layer.mergeAll(runtime.layer, probes.layer, makeEvidenceStoreMemory().layer),
          ),
        );
        expect(report).toMatchObject({
          stepId: "keel.human-class",
          outcome: "pass",
          evidenceClass: "ruling",
        });
        expect(runtime.jobs).toEqual([]);
        expect(probes.requests).toEqual([]);
        expect(durable.names).toEqual([]);
      }),
  );
});
