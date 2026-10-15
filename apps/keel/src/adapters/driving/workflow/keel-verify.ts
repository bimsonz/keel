import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  type DeployRun,
  type DeployServices,
  runDeployStep,
} from "@keeltown/core/application/delivery";
import {
  Admission,
  admitVerification,
  candidateRunner,
  type DeployStepRunner,
  ensureDeps,
  laneSteps,
  readStoredPlan,
  recordBatchVerdict,
  ResolvedPlan,
  resolvePlan,
  runPlan,
  SettledVerdict,
  settleMinutes,
  settleRefused,
  settleUnresolved,
  settleVerdict,
} from "@keeltown/core/application/verification";
import { Cause, Effect, Exit, Option, Result, Schema } from "effect";
import {
  admittedMinutes,
  durableReport,
  durableTell,
  keelVerifyRuntime,
} from "../../../composition/workflow.ts";
import { KeelVerifyJob } from "../../../rpc/index.ts";
import { keelBundleSource } from "./bundle-source.ts";
import { CIWorkflow, type CiContext, type CiParams } from "./ci.js";
import { depsSteps, namespaceStep } from "./steps.ts";

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
 * the job's `planHash`), `admit` (the namespace's container-minutes for one
 * attempt of the plan's Tier 2 steps, `planMinutes`: a refusal runs nothing,
 * and the verdict is `settleRefused`'s), then, for a plan with a Tier 2 step, `deps-need` and
 * `deps:<install digest>` (core's `ensureDeps`: the candidate's dependencies,
 * built once for the namespace and that digest, or why there are none), then
 * the plan's own steps as `runPlan` reaches them: a Tier 2 step is its runner's step (which persists its raw
 * logs, so a runner may hold nothing secret) and `<step>:evidence`, a guard
 * step is `guard <step>`, and one of Keel's deploy steps is `deploy <step>`,
 * each told to the lane as it runs (`started <step>` beside it, `finished
 * <step>` after it, for the public feed's step events),
 * run here in the Worker: the token of the target's account is opened inside
 * that step for Cloudflare's call and is never in what it returns, which is
 * persisted; then `verdict` (which settles the admitted minutes to what the
 * runners reported) and `record`. A plan the store does
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
      const run: DeployRun = {
        projectId: job.projectId,
        namespace,
        candidateId: job.candidateId,
        members: job.members ?? [],
        ...(job.candidateCommit === undefined ? {} : { candidateCommit: job.candidateCommit }),
      };
      // Persisted as JSON, since a refusal's next actions' args are open; decoded, so a replay is checked too.
      const admission = Result.isSuccess(plan)
        ? Schema.decodeUnknownSync(Admission)(
            JSON.parse(
              await step.do("admit", async () =>
                JSON.stringify(
                  Schema.encodeSync(Admission)(
                    await runtime.runPromise(
                      admitVerification(
                        namespace,
                        event.instanceId,
                        admittedMinutes(plan.success.steps),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : undefined;
      const deployServices = await runtime.runPromise(Effect.context<DeployServices>());
      const deploy: DeployStepRunner = (planStep, earlier) =>
        runDeployStep(run, planStep, earlier).pipe(Effect.provideContext(deployServices));
      const reports =
        Result.isSuccess(plan) && admission?._tag === "Admitted"
          ? await runtime.runPromise(
              runPlan(
                plan.success,
                candidateRunner(
                  namespace,
                  { jobId: job.jobId, bundle: job.bundle, fence: job.fence },
                  durableReport(step),
                  await runtime.runPromise(
                    ensureDeps(namespace, job.bundle, plan.success.steps, depsSteps(step)),
                  ),
                  deploy,
                ),
                laneSteps(
                  {
                    laneId: job.laneId,
                    instanceId: event.instanceId,
                    fence: job.fence,
                    candidateId: job.candidateId,
                  },
                  durableTell(step),
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
                  Result.isFailure(plan)
                    ? settleUnresolved(job.planHash, plan.failure)
                    : admission?._tag === "Refused"
                      ? settleRefused(namespace, job.planHash, admission.exceeded)
                      : settleVerdict(namespace, plan.success, reports).pipe(
                          Effect.tap(() =>
                            settleMinutes(
                              namespace,
                              event.instanceId,
                              admission?.minutes ?? 0,
                              reports,
                            ),
                          ),
                        ),
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
