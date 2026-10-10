import { Context, type Effect } from "effect";
import type { CommitSha, ProjectId } from "../../domain/kernel/index.ts";
import type { FlowSpec, FlowSpecInvalid } from "../../domain/verification/index.ts";

/** Reads `.keel/flow` and plugins from the **base** commit, so a change cannot edit its own checks. */
export class FlowSpecSource extends Context.Service<
  FlowSpecSource,
  {
    readonly read: (
      projectId: ProjectId,
      base: CommitSha,
    ) => Effect.Effect<FlowSpec, FlowSpecInvalid>;
  }
>()("keel/FlowSpecSource") {}
