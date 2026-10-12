import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { projectRepos } from "@keeltown/core/application/integration";
import {
  type ProbeEnd,
  type ProbeSteps,
  probeConflict,
  type StepPolicy,
} from "@keeltown/core/application/verification";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { ConflictId, ProjectId } from "@keeltown/core/kernel";
import { Effect, Option, Schema } from "effect";
import { probeRuntime } from "../../../composition/workflow.ts";

/** What the fan-out starts a Probe with, for ConflictSuspected: where the conflict lives. */
export const ProbeParams = Schema.Struct({
  projectId: ProjectId,
  key: SubjectKey,
  conflictId: ConflictId,
});
export type ProbeParams = typeof ProbeParams.Encoded;

/** Reads and ledger writes retry quickly; a draft calls the model up to four times, so it is given long and tried twice. */
const POLICIES: Readonly<Record<StepPolicy, WorkflowStepConfig>> = {
  quick: {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "5 minutes",
  },
  draft: { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "30 minutes" },
};

/** A waitForEvent that ran out: the platform throws, and the program reads it as no event. */
const timedOut = (error: unknown) =>
  error instanceof Error &&
  (error.name === "WorkflowTimeoutError" || /timed? ?out/i.test(error.message));

/**
 * The Workflow's durable steps for the core program: each `step` runs its
 * effect inside `step.do` with the program's services, kept as JSON, so a
 * replay answers what the first run kept; `waitFor` is `step.waitForEvent`.
 */
const workflowSteps = (step: WorkflowStep): ProbeSteps => ({
  step: <A, R>(name: string, effect: Effect.Effect<A, never, R>, policy: StepPolicy = "quick") =>
    Effect.flatMap(Effect.context<R>(), (services) =>
      Effect.promise(() =>
        step.do(name, POLICIES[policy], async (): Promise<string> =>
          JSON.stringify(await Effect.runPromise(Effect.provide(effect, services))),
        ),
      ).pipe(Effect.map((kept) => JSON.parse(kept))),
    ),
  waitFor: (name, type, timeoutMs) =>
    Effect.promise(async () => {
      try {
        await step.waitForEvent(name, { type, timeout: timeoutMs });
        return true;
      } catch (error) {
        if (timedOut(error)) return false;
        throw error;
      }
    }),
});

/** An end that is a harness error: the instance fails with it, never quietly. */
const failure = (end: ProbeEnd): string | undefined =>
  end.outcome === "unreadable"
    ? `world ${end.world} unreadable: ${end.repo}@${end.commit} (${end.reason})`
    : end.outcome === "errored"
      ? `${end.step}: ${end.reason}`
      : undefined;

/**
 * Probe, started by ConflictSuspected as `probe-<conflictId>` (one per
 * conflict): drafts the conflict's probe and reports it to the conflict's
 * Subject DO, through core's `probeConflict`, one durable step at a time. An
 * end that is a harness error (a world unreadable in staging, a conflict that
 * is not where its event said) logs one ops line and fails the instance.
 */
export class Probe extends WorkflowEntrypoint<Env, ProbeParams> {
  override async run(event: WorkflowEvent<ProbeParams>, step: WorkflowStep): Promise<ProbeEnd> {
    const params = Schema.decodeUnknownOption(ProbeParams)(event.payload);
    if (Option.isNone(params)) throw new NonRetryableError("not a Probe's params");
    const runtime = probeRuntime(this.env);
    try {
      const end = await runtime.runPromise(
        probeConflict(
          {
            ...params.value,
            instanceId: event.instanceId,
            staging: projectRepos(params.value.projectId).staging,
          },
          workflowSteps(step),
        ),
      );
      const failed = failure(end);
      if (failed !== undefined) {
        console.error(
          JSON.stringify({ ops: "probe", instance: event.instanceId, problem: failed }),
        );
        throw new NonRetryableError(failed);
      }
      return end;
    } finally {
      await runtime.dispose();
    }
  }
}
