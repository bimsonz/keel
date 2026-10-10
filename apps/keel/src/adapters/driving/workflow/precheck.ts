import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { NotImplemented } from "@keeltown/core/not-implemented";
import { Cause, Effect, Exit } from "effect";
import { workflowRuntime } from "../../../composition/workflow.ts";

export interface PrecheckParams {
  readonly changeId: string;
  readonly revision: number;
}

/**
 * Precheck, started by `ChangeSubmitted`: diff the workspace against head,
 * refuse protected paths, derive effects, classify drift, compile the plan.
 * A permanent failure throws `NonRetryableError`; a transient one throws, so
 * the step retries.
 */
export class Precheck extends WorkflowEntrypoint<Env, PrecheckParams> {
  override async run(event: WorkflowEvent<PrecheckParams>, step: WorkflowStep) {
    const runtime = workflowRuntime(this.env);
    await step.do("derive", async () => {
      const exit = await runtime.runPromiseExit(
        Effect.die(new NotImplemented(`precheck of ${event.payload.changeId}`)),
      );
      if (Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof NotImplemented) {
        throw new NonRetryableError("Precheck is not implemented yet");
      }
      return null;
    });
  }
}
