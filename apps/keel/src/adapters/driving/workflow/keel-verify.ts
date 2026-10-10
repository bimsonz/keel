import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  L1_SUITE_PLAN,
  recordBatchVerdict,
  runJob,
  settleVerdict,
} from "@keeltown/core/application/verification";
import type { VerificationJob } from "@keeltown/core/domain/verification";
import { Cause, Exit, Option, Schema } from "effect";
import { keelVerifyRuntime } from "../../../composition/workflow.ts";
import { KeelVerifyJob } from "../../../rpc/index.ts";
import { keelBundleSource } from "./bundle-source.ts";
import { CIWorkflow, type CiContext, type CiParams } from "./ci.js";

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
 * Steps: `plan` (the payload and its plan), the runner's own step (which
 * persists its raw logs, so a runner may hold nothing secret),
 * `<step>:evidence`, `verdict` and `record`. At L1 the plan is static: the
 * js-ts suite in Tier 2.
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
    const encoded = await step.do("plan", async () => {
      const job = Schema.decodeUnknownOption(KeelVerifyJob)(event.payload);
      if (Option.isNone(job)) throw new NonRetryableError("not a KeelVerify job");
      if (job.value.planHash !== L1_SUITE_PLAN.planHash)
        throw new NonRetryableError(`KeelVerify does not know plan ${job.value.planHash}`);
      return Schema.encodeSync(KeelVerifyJob)(job.value);
    });
    const job = Schema.decodeSync(KeelVerifyJob)(encoded);
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
      const verification: VerificationJob = {
        jobId: job.jobId,
        bundle: job.bundle,
        steps: L1_SUITE_PLAN.steps,
        fence: job.fence,
      };
      const results = await runtime.runPromise(runJob(verification));
      const settled = await step.do("verdict", () =>
        runtime.runPromise(settleVerdict(L1_SUITE_PLAN, results)),
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
