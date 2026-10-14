import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { deliverTrunk } from "@keeltown/core/application/delivery";
import { Option, Schema } from "effect";
import { deliverRuntime } from "../../../composition/workflow.ts";
import { DeliverJob } from "../../../rpc/index.ts";

/**
 * Deliver, started by a TrunkAdvanced (one instance per project and trunk
 * commit): deploys trunk on the project's deploy target from the preview
 * KeelVerify made of the landed candidate, or says why not (core's
 * `deliverTrunk`). One step, `deliver`: the token is opened inside it for
 * Cloudflare's call, and what it returns, which is persisted, names only the
 * outcome.
 */
export class Deliver extends WorkflowEntrypoint<Env> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const job = Schema.decodeUnknownOption(DeliverJob)(event.payload);
    if (Option.isNone(job)) throw new NonRetryableError("not a Deliver job");
    return step.do("deliver", async () => {
      const runtime = deliverRuntime(this.env);
      try {
        return await runtime.runPromise(deliverTrunk(job.value));
      } finally {
        await runtime.dispose();
      }
    });
  }
}
