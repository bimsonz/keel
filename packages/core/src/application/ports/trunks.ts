import { Context, type Effect } from "effect";
import type { PromotionStateRefused } from "../../domain/integration/index.ts";
import type { CommitSha, ProjectId } from "../../domain/kernel/index.ts";

/** Where a sync left the project's repos: trunk's head, and staging and the mirror brought to it. */
export interface TrunkSynced {
  readonly head: CommitSha;
  readonly staging: CommitSha;
  readonly mirror: CommitSha;
}

/** A project's trunk, through its Trunk DO (`trunk:<projectId>`). */
export class Trunks extends Context.Service<
  Trunks,
  {
    /**
     * Names trunk's first head. A retry with the same head answers as before;
     * another head, or any once trunk has one, is PromotionStateRefused.
     */
    readonly initialize: (
      projectId: ProjectId,
      head: CommitSha,
      by: string,
    ) => Effect.Effect<void, PromotionStateRefused>;
    /**
     * Trunk's head as its Trunk DO records it: what the Lane composes onto,
     * never a ref read that may lag or lead it. Dies for a trunk not yet
     * initialized, since no change exists in such a project.
     */
    readonly head: (projectId: ProjectId) => Effect.Effect<CommitSha>;
    /** Brings staging and the project's mirror to trunk's head. Idempotent. */
    readonly sync: (projectId: ProjectId) => Effect.Effect<TrunkSynced>;
  }
>()("keel/Trunks") {}
