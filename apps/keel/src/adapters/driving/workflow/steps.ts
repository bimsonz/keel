import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  describeNoNamespace,
  jobNamespace,
  type ProbeSteps,
  projectNamespace,
  type StepPolicy,
} from "@keeltown/core/application/verification";
import { NamespaceId, type ProjectId } from "@keeltown/core/kernel";
import type { ProjectNamespaces } from "@keeltown/core/ports";
import { Effect, Option, Result, Schema } from "effect";

/** Reads and ledger writes retry quickly; a draft calls the model up to four times, so it is given long and tried twice. */
const POLICIES: Readonly<Record<StepPolicy, WorkflowStepConfig>> = {
  quick: {
    retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
    timeout: "5 minutes",
  },
  draft: { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "30 minutes" },
};

/**
 * The `namespace` step every Workflow of a project runs before it keeps or
 * reads anything of that project: the namespace the project belongs to, read
 * once and kept, so each store call of the instance names it. A project with
 * no place ends the instance at once, naming the project: there is no
 * namespace to fall back on, and trying again finds none. `named` is the
 * namespace a job's payload carries (the engine fixes where runners fetch
 * their bundle from the payload, before any step): the step reads the
 * project's own again, and a job naming another ends the same way.
 */
export async function namespaceStep(
  step: WorkflowStep,
  run: <A>(effect: Effect.Effect<A, never, ProjectNamespaces>) => Promise<A>,
  projectId: ProjectId,
  named?: NamespaceId,
): Promise<NamespaceId> {
  const kept = await step.do("namespace", POLICIES.quick, async (): Promise<string> => {
    const read = await run(
      Effect.result(
        named === undefined ? projectNamespace(projectId) : jobNamespace(projectId, named),
      ),
    );
    if (Result.isFailure(read)) throw new NonRetryableError(describeNoNamespace(read.failure));
    return read.success;
  });
  return Schema.decodeUnknownSync(NamespaceId)(kept);
}

/**
 * Precheck's `namespace` step: the namespace the project belongs to, or
 * `undefined` for a project with no place, kept either way. Precheck answers
 * a submission, so it refuses one on the change's own log; every other
 * Workflow of a project follows a plan its Precheck compiled, and ends
 * instead (`namespaceStep`).
 */
export async function placedStep(
  step: WorkflowStep,
  run: <A>(effect: Effect.Effect<A, never, ProjectNamespaces>) => Promise<A>,
  projectId: ProjectId,
): Promise<NamespaceId | undefined> {
  const kept = await step.do("namespace", POLICIES.quick, async (): Promise<string | null> =>
    Option.getOrNull(await run(Effect.option(projectNamespace(projectId)))),
  );
  return kept === null ? undefined : Schema.decodeUnknownSync(NamespaceId)(kept);
}

/** A waitForEvent that ran out: the platform throws, and the program reads it as no event. */
const timedOut = (error: unknown) =>
  error instanceof Error &&
  (error.name === "WorkflowTimeoutError" || /timed? ?out/i.test(error.message));

/**
 * A Workflow's durable steps for a core program: each `step` runs its
 * effect inside `step.do` with the program's services, kept as JSON, so a
 * replay answers what the first run kept; `waitFor` is `step.waitForEvent`.
 */
export const workflowSteps = (step: WorkflowStep): ProbeSteps => ({
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
