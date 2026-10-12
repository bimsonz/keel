import { BatchVerification } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { keelVerifyParams } from "../../../rpc/keel-verify.ts";

/** The two calls a start makes on a Workflow binding. */
export interface WorkflowStarts {
  get(id: string): Promise<unknown>;
  create(options: { id: string; params: Readonly<Record<string, unknown>> }): Promise<unknown>;
}

/** Whether the binding already holds an instance by this id; `get` throws for one it does not. */
export async function exists(workflow: WorkflowStarts, id: string): Promise<boolean> {
  try {
    await workflow.get(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * BatchVerification over KeelVerify's Workflow binding (`CI_WORKFLOW`): one
 * instance per id, the job encoded as KeelVerify's params. An id the binding
 * already holds is a started instance, so the Lane's retried step starts
 * nothing new. A create that fails for any other reason is a defect, and the
 * Lane's step runs again.
 */
export const BatchVerificationWorkflow = (workflow: WorkflowStarts) =>
  Layer.succeed(
    BatchVerification,
    BatchVerification.of({
      start: (instanceId, job) =>
        Effect.promise(async () => {
          if (await exists(workflow, instanceId)) return;
          await workflow.create({ id: instanceId, params: keelVerifyParams(job) });
        }),
    }),
  );
