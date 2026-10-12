import { WorldChecks } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { WorldCheckJob, worldCheckParams } from "../../../rpc/index.ts";
import { exists, type WorkflowStarts } from "./batch-verification.ts";

/**
 * WorldChecks over KeelWorldCheck's Workflow binding (`WORLD_CHECK`): one
 * instance per id, the job encoded as KeelWorldCheck's params. A create that
 * fails for an id the binding already holds is a started instance, so the
 * Probe's retried step starts nothing new; one that fails for any other
 * reason is a defect, and the Probe's step runs again.
 */
export const WorldChecksWorkflow = (workflow: WorkflowStarts) =>
  Layer.succeed(
    WorldChecks,
    WorldChecks.of({
      start: (instanceId, job) =>
        Effect.promise(async () => {
          try {
            await workflow.create({
              id: instanceId,
              params: worldCheckParams(Schema.decodeUnknownSync(WorldCheckJob)(job)),
            });
          } catch (cause) {
            // Already started by an earlier run of the Probe's step: that is the start.
            if (!(await exists(workflow, instanceId))) throw cause;
          }
        }),
    }),
  );
