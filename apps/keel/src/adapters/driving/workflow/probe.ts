import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { projectRepos } from "@keeltown/core/application/integration";
import { type ProbeEnd, probeConflict } from "@keeltown/core/application/verification";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { ConflictId, ProjectId } from "@keeltown/core/kernel";
import { Option, Schema } from "effect";
import { probeRuntime } from "../../../composition/workflow.ts";
import { workflowSteps } from "./steps.ts";

/** What the fan-out starts a Probe with, for ConflictSuspected: where the conflict lives. */
export const ProbeParams = Schema.Struct({
  projectId: ProjectId,
  key: SubjectKey,
  conflictId: ConflictId,
});
export type ProbeParams = typeof ProbeParams.Encoded;

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
