import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { translateArtifactsPush } from "../queue/artifacts-events.ts";

/**
 * One instance per push to a workspace namespace, started by a namespace-wide
 * `triggers.events` rule (spike S6: 0 of 200 pushes missed). Pushes only
 * observe plain-git agents; `submit` stays authoritative. Tags, notes,
 * deletions and force pushes arrive too, so only branch updates count.
 */
export class PushObserved extends WorkflowEntrypoint<Env> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    await step.do("observe", async () => {
      const pushed = translateArtifactsPush(event.payload);
      // The WorkspacePool DO records WorkspacePushed once it is built; until then it is logged only.
      if (pushed !== null)
        console.log("workspace pushed", pushed.workspaceId, pushed.ref, pushed.sha);
      return pushed === null
        ? null
        : { workspaceId: pushed.workspaceId, ref: pushed.ref, sha: pushed.sha };
    });
  }
}
