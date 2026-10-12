import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import type { ProbeSteps, StepPolicy } from "@keeltown/core/application/verification";
import { Effect } from "effect";

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
