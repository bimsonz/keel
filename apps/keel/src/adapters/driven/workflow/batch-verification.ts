import { redact } from "@keeltown/core/application/verification";
import { BatchVerification, type InstanceStanding } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { keelVerifyParams } from "../../../rpc/keel-verify.ts";

/** What the adapter reads and asks of one instance. */
export interface WorkflowRun {
  status(): Promise<{
    readonly status: string;
    readonly error?: { readonly name: string; readonly message: string } | null;
  }>;
  terminate(): Promise<unknown>;
}

/** The calls the adapter makes on a Workflow binding. */
export interface WorkflowStarts {
  get(id: string): Promise<WorkflowRun>;
  create(options: { id: string; params: Readonly<Record<string, unknown>> }): Promise<unknown>;
}

/** An instance's own error message is cited no longer than this. */
export const INSTANCE_ERROR_MAX = 200;

/** The platform's states an instance may still leave with a verdict. */
const RUNNING = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
  "rollingBack",
]);

/**
 * Keel's reading of the platform's status of an instance. A message is
 * third-party text: it is redacted and cut here, before it can reach an
 * event.
 */
export function standingOf(run: Awaited<ReturnType<WorkflowRun["status"]>>): InstanceStanding {
  if (run.status === "complete") return { _tag: "Completed" };
  if (RUNNING.has(run.status)) return { _tag: "Running" };
  if (run.status === "terminated") return { _tag: "Failed", status: "terminated" };
  if (run.status !== "errored") return { _tag: "Failed", status: "unknown" };
  const message = run.error?.message;
  return message === undefined || message === ""
    ? { _tag: "Failed", status: "errored" }
    : { _tag: "Failed", status: "errored", error: redact(message).slice(0, INSTANCE_ERROR_MAX) };
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
 * Lane's step runs again. An id the binding does not hold stands `missing`,
 * and stopping it, or an instance that has ended, does nothing.
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
      standing: (instanceId) =>
        Effect.promise(async () => {
          if (!(await exists(workflow, instanceId))) return { _tag: "Failed", status: "missing" };
          return standingOf(await (await workflow.get(instanceId)).status());
        }),
      stop: (instanceId) =>
        Effect.promise(async () => {
          if (!(await exists(workflow, instanceId))) return;
          const run = await workflow.get(instanceId);
          if (standingOf(await run.status())._tag === "Running") await run.terminate();
        }),
    }),
  );
