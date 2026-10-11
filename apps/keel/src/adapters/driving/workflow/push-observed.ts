import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { WorkspacePool } from "@keeltown/core/ports";
import { Effect } from "effect";
import { pushObservedRuntime } from "../../../composition/workflow.ts";
import { translateArtifactsPush } from "../queue/artifacts-events.ts";

/**
 * One instance per push to a workspace namespace, started by a namespace-wide
 * `triggers.events` rule (spike S6: 0 of 200 pushes missed). Pushes only
 * observe plain-git agents; `submit` stays authoritative. Tags, notes,
 * deletions and force pushes arrive too, so only branch updates count. The
 * project's pool commits WorkspacePushed only for a granted workspace, once
 * per instance: Keel's own writes (refills, the mirror) wake nobody.
 */
export class PushObserved extends WorkflowEntrypoint<Env> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const pushed = translateArtifactsPush(event.payload);
    if (pushed === null) return null;
    return step.do("observe", async () => {
      const runtime = pushObservedRuntime(this.env);
      const outcome = await runtime.runPromise(
        Effect.flatMap(WorkspacePool, (pool) =>
          pool.observePush(pushed.projectId, event.instanceId, pushed.push),
        ),
      );
      return { workspaceId: pushed.push.workspaceId, ref: pushed.push.ref, outcome };
    });
  }
}
