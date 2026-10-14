import { Effect, Result, Schema } from "effect";
import type { ContentHash, NextAction, NamespaceId } from "../../domain/kernel/index.ts";
import {
  type FlowWorld,
  type PlanStep,
  type StepReport,
  StepResult,
  type VerificationJob,
} from "../../domain/verification/index.ts";
import { EvidenceStore, Ids, PlanStore, ProbeRunner, VerifierRuntime } from "../ports/index.ts";
import type { DepsAnswer } from "./deps.ts";
import { withGuards } from "./guard-step.ts";
import { storedPlanText } from "./plan-codec.ts";
import type { StepRunner } from "./run-plan.ts";
import { runJob, type SettledVerdict } from "./verify-candidate.ts";

/**
 * KeelVerify's plan: the one Precheck compiled and stored under the hash the
 * job names. The `plan` step persists it as the stored text, which the
 * Workflow decodes and verifies against the hash again on every replay, or
 * says why it could not be resolved.
 */
export const ResolvedPlan = Schema.Union([
  Schema.TaggedStruct("Resolved", { text: Schema.String }),
  Schema.TaggedStruct("Unresolved", { why: Schema.String }),
]);
export type ResolvedPlan = typeof ResolvedPlan.Type;

/** The plan stored under the job's hash, or why it is not there: missing, or not the plan it names. */
export const resolvePlan = Effect.fn("verification/resolvePlan")(function* (
  namespace: NamespaceId,
  planHash: ContentHash,
) {
  return yield* (yield* PlanStore).get(namespace, planHash).pipe(
    Effect.map((plan): ResolvedPlan => {
      const text = storedPlanText(plan);
      return Result.isSuccess(text)
        ? { _tag: "Resolved", text: text.success }
        : { _tag: "Unresolved", why: `plan ${planHash} is stored corrupt: ${text.failure}` };
    }),
    Effect.catchTags({
      PlanMissing: () =>
        Effect.succeed<ResolvedPlan>({
          _tag: "Unresolved",
          why: `plan ${planHash} is not in the plan store`,
        }),
      PlanCorrupt: (e) =>
        Effect.succeed<ResolvedPlan>({
          _tag: "Unresolved",
          why: `plan ${planHash} is stored corrupt: ${e.reason}`,
        }),
    }),
  );
});

const resubmit: NextAction = {
  kind: "call",
  title:
    "Submit the change again: Precheck compiles and stores its plan afresh, and the lane verifies that plan",
  operationId: "submit",
};

/**
 * The verdict on a job whose plan could not be resolved: park, never run a
 * plan other than the one compiled and never fail the instance, which would
 * leave the lane waiting on it. A plan Precheck compiled before plans were
 * stored, or one lost or edited in the store, ends here.
 */
export const settleUnresolved = Effect.fn("verification/settleUnresolved")(function* (
  planHash: ContentHash,
  why: string,
) {
  const settled: SettledVerdict = {
    verdictId: yield* (yield* Ids).next("vrd"),
    outcome: "park",
    planHash,
    evidence: [`plan: ${why}`],
    failingTests: [],
    nextActions: [resubmit],
  };
  return settled;
});

/** A report as a Workflow step persists it: a step result whose outcome Keel has yet to trust. */
export const StoredStepReport = Schema.Struct({
  ...StepResult.fields,
  outcome: Schema.String,
  failure: Schema.optionalKey(
    Schema.Literals(["timeout", "rate-limited", "schema", "truncated", "unavailable"]),
  ),
});

/**
 * Makes one step's report durable: a Workflow step named `name`, so a replay
 * reads what the first run reported rather than running it again.
 */
export type DurableReport = (
  name: string,
  report: Effect.Effect<StepReport>,
) => Effect.Effect<StepReport>;

const abstainUnrun = (step: PlanStep, world: FlowWorld | undefined): StepReport => ({
  stepId: step.id,
  outcome: "abstain",
  failure: "unavailable",
  evidenceClass: step.evidenceCeiling,
  tier:
    world === undefined
      ? step.tier
      : { tier: step.tier.tier, reason: `no ${world} world at a lane: worlds are a conflict's` },
  durationMs: 0,
  ...(world === undefined ? {} : { world }),
});

/**
 * How a run deploys: Keel's own step for a deploy step, given what the steps
 * before it in the run reported. The caller makes it, with the candidate and
 * the services it deploys with, so a run with nothing to deploy needs none.
 */
export type DeployStepRunner = (
  step: PlanStep,
  earlier: ReadonlyMap<string, StepReport>,
) => Effect.Effect<StepReport>;

/**
 * The runner a candidate's plan runs on. A step asked for a world abstains
 * unrun: a lane verifies one candidate, and the worlds A, B and AB belong to
 * a conflict's matrix. A guard step runs the probe its plan pins against the
 * candidate (`withGuards`) in one durable step, so a replay never runs the
 * probe again and reads the same duration. Every other step is a one-step job
 * on the VerifierRuntime, whose Tier 2 runners are durable themselves and are
 * handed `deps`, what the Workflow ensured for the candidate; a step it has
 * no runner for abstains there.
 *
 * A deploy step runs here, in Tier 0, as one durable step (`deploy <step>`),
 * by `deploy`. It reads what the steps before it in this run reported (a preview uploads the
 * build's module; smoke asks the preview's address): the runner keeps each
 * report it answers for that, and a replay keeps the same ones, since each
 * came from a durable step. With no `deploy`, a deploy step abstains unrun.
 */
export const candidateRunner = (
  namespace: NamespaceId,
  job: Omit<VerificationJob, "steps">,
  durable: DurableReport,
  deps: DepsAnswer,
  deploy?: DeployStepRunner,
): StepRunner<ProbeRunner | VerifierRuntime | EvidenceStore> => {
  const reported = new Map<string, StepReport>();
  const keep = (step: PlanStep) => (report: StepReport) =>
    Effect.sync(() => {
      reported.set(step.id, report);
    });
  const run: StepRunner<ProbeRunner | VerifierRuntime | EvidenceStore> = (step, world) => {
    if (world !== undefined) return Effect.succeed(abstainUnrun(step, world));
    if (step.kind === "deploy")
      return deploy === undefined
        ? Effect.succeed(abstainUnrun(step, undefined))
        : durable(`deploy ${step.id}`, deploy(step, reported));
    const asJob: StepRunner<VerifierRuntime> = (s) =>
      runJob(namespace, { ...job, steps: [s] }, deps).pipe(
        Effect.map((reports): StepReport => reports[0] ?? abstainUnrun(s, undefined)),
      );
    if (step.guards === undefined) return asJob(step, undefined);
    return Effect.gen(function* () {
      const probes = yield* ProbeRunner;
      const runtime = yield* VerifierRuntime;
      const evidence = yield* EvidenceStore;
      return yield* durable(
        `guard ${step.id}`,
        withGuards(
          namespace,
          job.bundle,
          asJob,
        )(step, undefined).pipe(
          Effect.provideService(ProbeRunner, probes),
          Effect.provideService(VerifierRuntime, runtime),
          Effect.provideService(EvidenceStore, evidence),
        ),
      );
    });
  };
  return (step, world) =>
    world === undefined ? Effect.tap(run(step, world), keep(step)) : run(step, world);
};
