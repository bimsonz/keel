import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  candidateRunner,
  readStoredPlan,
  recordBatchVerdict,
  ResolvedPlan,
  resolvePlan,
  runPlan,
  SettledVerdict,
  settleUnresolved,
  settleVerdict,
} from "@keeltown/core/application/verification";
import { Cause, Exit, Option, Result, Schema } from "effect";
import { durableReport, keelVerifyRuntime } from "../../../composition/workflow.ts";
import { KeelVerifyJob } from "../../../rpc/index.ts";
import { keelBundleSource } from "./bundle-source.ts";
import { CIWorkflow, type CiContext, type CiParams } from "./ci.js";
import { namespaceStep } from "./steps.ts";

const RECORD_RETRIES = {
  retries: { limit: 3, delay: "2 seconds", backoff: "constant" },
  timeout: "1 minute",
} as const;

/**
 * KeelVerify, started for a batch's candidate: runs its Verification Plan
 * across the tiers and reports the verdict to the lane. A subclass of
 * @cloudflare/ci's CIWorkflow, not a fork (spike S15): Tier 2 steps are
 * `ci.runner`s on keel-verify's KeelSandbox, hydrated from the candidate's
 * bundle through `getProvider()`, never from git and never with a token.
 *
 * Steps: `namespace` (the project's namespace, which must be the one the
 * payload names: the bundle, the plan and the evidence are all kept under
 * it), `plan` (the payload, and the plan Precheck compiled and stored under
 * the job's `planHash`), then the plan's own steps as `runPlan`
 * reaches them: a Tier 2 step is its runner's step (which persists its raw
 * logs, so a runner may hold nothing secret) and `<step>:evidence`, a guard
 * step is `guard <step>`; then `verdict` and `record`. A plan the store does
 * not hold, or holds corrupt, runs nothing and settles park: the lane is
 * never left waiting on a failed instance.
 */
export class KeelVerify extends CIWorkflow<Env> {
  static override getProvider() {
    return keelBundleSource;
  }

  protected override async pipeline(
    event: WorkflowEvent<CiParams>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const runtime = keelVerifyRuntime(this.env, {
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
      const payload = Schema.decodeUnknownOption(KeelVerifyJob)(event.payload);
      if (Option.isNone(payload)) throw new NonRetryableError("not a KeelVerify job");
      // The runners fetch the candidate from the namespace the payload names: it must be the project's own.
      const namespace = await namespaceStep(
        step,
        (effect) => runtime.runPromise(effect),
        payload.value.projectId,
        payload.value.namespace,
      );
      const planned = await step.do("plan", async () => {
        const resolved = await runtime.runPromise(resolvePlan(namespace, payload.value.planHash));
        return {
          job: Schema.encodeSync(KeelVerifyJob)(payload.value),
          plan: Schema.encodeSync(ResolvedPlan)(resolved),
        };
      });
      const job = Schema.decodeSync(KeelVerifyJob)(planned.job);
      const resolved = Schema.decodeSync(ResolvedPlan)(planned.plan);
      // Read back and verified against the job's hash on every replay, not only the first run.
      const plan =
        resolved._tag === "Resolved"
          ? readStoredPlan(job.planHash, resolved.text)
          : Result.fail(resolved.why);
      const reports = Result.isSuccess(plan)
        ? await runtime.runPromise(
            runPlan(
              plan.success,
              candidateRunner(
                namespace,
                { jobId: job.jobId, bundle: job.bundle, fence: job.fence },
                durableReport(step),
              ),
            ),
          )
        : [];
      // Persisted as JSON, since a next action's args are open; decoded, so a replay is checked too.
      const settled = Schema.decodeUnknownSync(SettledVerdict)(
        JSON.parse(
          await step.do("verdict", async () =>
            JSON.stringify(
              Schema.encodeSync(SettledVerdict)(
                await runtime.runPromise(
                  Result.isSuccess(plan)
                    ? settleVerdict(namespace, plan.success, reports)
                    : settleUnresolved(job.planHash, plan.failure),
                ),
              ),
            ),
          ),
        ),
      );
      // A lane that cannot take the verdict now is retried a few times, not for minutes.
      await step.do("record", RECORD_RETRIES, async () => {
        const exit = await runtime.runPromiseExit(
          recordBatchVerdict({
            laneId: job.laneId,
            instanceId: event.instanceId,
            fence: job.fence,
            candidateId: job.candidateId,
            settled,
          }),
        );
        if (Exit.isSuccess(exit)) return settled.outcome;
        const failure = Cause.findErrorOption(exit.cause);
        // A fenced result or an unknown candidate never gets better by retrying.
        if (Option.isSome(failure)) throw new NonRetryableError(failure.value._tag);
        throw Cause.squash(exit.cause);
      });
    } finally {
      await runtime.dispose();
    }
  }
}
