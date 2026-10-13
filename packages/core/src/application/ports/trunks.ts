import { Context, type Effect } from "effect";
import type { PromotionStateRefused } from "../../domain/integration/index.ts";
import type { CommitSha, Instant, ProjectId } from "../../domain/kernel/index.ts";

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
     * Makes main at `commit` in a trunk that was imported under another
     * branch's name, through the trunk's one writer (`TrunkWriter.adopt`). A
     * first write: asked of a trunk that is already initialized it is a
     * defect, and nothing is written.
     */
    readonly adopt: (projectId: ProjectId, commit: CommitSha) => Effect.Effect<void>;
    /**
     * Writes an empty trunk's first commit through the trunk's one writer
     * (`TrunkWriter.seed`) and answers it. The same `name` and `at` give the
     * same commit, so a retry finds it. A first write: asked of a trunk that
     * is already initialized it is a defect, and nothing is written.
     */
    readonly seed: (projectId: ProjectId, name: string, at: Instant) => Effect.Effect<CommitSha>;
    /**
     * Trunk's head as its Trunk DO records it: what the Lane composes onto,
     * never a ref read that may lag or lead it. Dies for a trunk not yet
     * initialized, since no change exists in such a project.
     */
    readonly head: (projectId: ProjectId) => Effect.Effect<CommitSha>;
    /** Brings staging and the project's mirror to trunk's head. Idempotent. */
    readonly sync: (projectId: ProjectId) => Effect.Effect<TrunkSynced>;
    /**
     * Destroys the project's trunk, for good (its project was deleted): it
     * promotes nothing from here on, and its trunk, staging, mirror and guards
     * repos are deleted, retried until none is left. Idempotent.
     */
    readonly destroy: (projectId: ProjectId, by: string) => Effect.Effect<void>;
  }
>()("keel/Trunks") {}
