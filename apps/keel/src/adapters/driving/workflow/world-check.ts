import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  ensureDeps,
  readStoredPlan,
  recordWorldCheck,
  ResolvedPlan,
  resolveCheckPlans,
  resolvePlan,
  runJob,
  type WorldCheckOutcome,
  worldCheckCell,
  worldCheckRunSteps,
} from "@keeltown/core/application/verification";
import type { FlowPlan } from "@keeltown/core/domain/verification";
import { Option, Result, Schema } from "effect";
import { worldCheckRuntime } from "../../../composition/workflow.ts";
import { WorldCheckJob } from "../../../rpc/index.ts";
import { keelBundleSource } from "./bundle-source.ts";
import { CIWorkflow, type CiContext, type CiParams } from "./ci.js";
import { depsSteps, namespaceStep, workflowSteps } from "./steps.ts";

const RECORD_RETRIES = {
  retries: { limit: 3, delay: "2 seconds", backoff: "constant" },
  timeout: "1 minute",
} as const;

/**
 * KeelWorldCheck, started by a conflict's Probe once its probe is drafted:
 * the changes' existing suites in one world of the conflict's matrix,
 * Q-E), each check's outcome recorded to the conflict's Subject DO as a
 * WorldCheckRan. They are evidence for people, not for admission. A subclass
 * of @cloudflare/ci's CIWorkflow, as KeelVerify is: Tier 2 steps are
 * `ci.runner`s on keel-verify's KeelSandbox, hydrated from the world's
 * bundle, never from git and never with a token.
 *
 * Steps: `namespace` (the project's namespace, which must be the one the job
 * names: the world's bundle, the plans and the evidence are kept under it);
 * then a party's check reads its change's plan (core's
 * `resolveCheckPlans`): the Probe starts these the moment a party submits, so
 * a plan its Precheck has not compiled yet is waited for by event, up to five
 * minutes, never polled. Then `plan <check>` for each check with a plan,
 * `deps-need` and `deps:<install digest>` when those plans hold a Tier 2 step
 * (core's `ensureDeps`, on the world's bundle), every Tier 2 step they hold,
 * each run once (the same step on the
 * same bundle answers the same for every check, and AB holds two), and
 * `record <check>`. A change that ends with no plan, a wait that runs out, or
 * a plan the store does not hold or holds corrupt makes its check n/a,
 * saying why.
 */
export class KeelWorldCheck extends CIWorkflow<Env> {
  static override getProvider() {
    return keelBundleSource;
  }

  protected override async pipeline(
    event: WorkflowEvent<CiParams>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const decoded = Schema.decodeUnknownOption(WorldCheckJob)(event.payload);
    if (Option.isNone(decoded)) throw new NonRetryableError("not a KeelWorldCheck job");
    const job = decoded.value;
    const runtime = worldCheckRuntime(this.env, {
      // Restated here, not passed through: no runner is ever handed a credential.
      runner: (options) =>
        ci.runner({
          name: options.name,
          command: options.command,
          env: options.env,
          config: options.config,
          cloudflareCredentials: false,
          sourceControlCredentials: false,
        }),
      step,
    });
    try {
      // The runners fetch the world's bundle from the namespace the job names: it must be the project's own.
      const namespace = await namespaceStep(
        step,
        (effect) => runtime.runPromise(effect),
        job.projectId,
        job.namespace,
      );
      const checks = await runtime.runPromise(
        resolveCheckPlans(job.checks, event.instanceId, workflowSteps(step)),
      );
      const plans = new Map<string, Result.Result<FlowPlan, string>>();
      for (const { check, plan } of checks) {
        if (plan._tag === "Unplanned") {
          plans.set(check, Result.fail(plan.reason));
          continue;
        }
        const resolved = Schema.decodeSync(ResolvedPlan)(
          await step.do(`plan ${check}`, async () =>
            Schema.encodeSync(ResolvedPlan)(
              await runtime.runPromise(resolvePlan(namespace, plan.planHash)),
            ),
          ),
        );
        // Read back and verified against the check's hash on every replay, not only the first run.
        plans.set(
          check,
          resolved._tag === "Resolved"
            ? readStoredPlan(plan.planHash, resolved.text)
            : Result.fail(resolved.why),
        );
      }
      const steps = worldCheckRunSteps(
        [...plans.values()].flatMap((plan) => (Result.isSuccess(plan) ? [plan.success] : [])),
      );
      // With no Tier 2 step to run, no deps are needed and neither deps step runs.
      const deps = await runtime.runPromise(
        ensureDeps(namespace, job.bundle, steps, depsSteps(step)),
      );
      const reports =
        steps.length === 0
          ? []
          : await runtime.runPromise(
              runJob(
                namespace,
                {
                  jobId: event.instanceId,
                  bundle: job.bundle,
                  fence: { batchId: event.instanceId, attempt: 1, chainEpoch: 0 },
                  steps,
                },
                deps,
              ),
            );
      for (const { check } of job.checks) {
        const plan = plans.get(check) ?? Result.fail("no plan");
        const cell: WorldCheckOutcome = Result.isSuccess(plan)
          ? worldCheckCell(plan.success, reports, deps)
          : { outcome: "n/a", reason: plan.failure };
        // A refusal (the conflict moved on) is kept as the step's value: retrying never helps.
        await step.do(`record ${check}`, RECORD_RETRIES, async () =>
          JSON.stringify(await runtime.runPromise(recordWorldCheck(job, check, cell))),
        );
      }
    } finally {
      await runtime.dispose();
    }
  }
}
