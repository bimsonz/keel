import { CIWorkflow, type CiContext, type CiParams } from "./ci.js";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

/**
 * KeelVerify, started by `BatchFormed`: runs the union of a batch's
 * Verification Plans across the tiers. A subclass of @cloudflare/ci's
 * CIWorkflow, not a fork (spike S15): Tier 2 steps are `ci.runner`s on
 * keel-verify's KeelSandbox, Tier 0 and 1 steps plain `step.do`s. Keel
 * writes the pipeline.
 */
export class KeelVerify extends CIWorkflow<Env> {
  protected override async pipeline(_event: WorkflowEvent<CiParams>, step: WorkflowStep, _ci: CiContext): Promise<void> {
    await step.do("plan", async () => {
      throw new NonRetryableError("KeelVerify's pipeline is not implemented yet");
    });
  }
}
