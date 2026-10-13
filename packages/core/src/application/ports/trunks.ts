import { Context, type Effect, type Option, Schema } from "effect";
import type { QuotaExceeded } from "../../domain/identity/index.ts";
import type { PromotionStateRefused, TrunkOrigin } from "../../domain/integration/index.ts";
import type { CommitSha, Instant, ProjectId } from "../../domain/kernel/index.ts";

/**
 * An imported history too large to become a project: its one pack is over
 * what a relay carries (`limit`), so staging and the mirror could never be
 * brought to trunk's head. Trunk was given no head.
 */
export class ImportTooLarge extends Schema.TaggedError<ImportTooLarge>()("ImportTooLarge", {
  projectId: Schema.String,
  bytes: Schema.Number,
  limit: Schema.Number,
}) {}

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
     * Names trunk's first head, and where it came from: `origin` is recorded
     * on TrunkInitialized as given, and one naming another commit than `head`
     * is a defect. A retry with the same head answers as before; another
     * head, or any once trunk has one, is PromotionStateRefused. An imported
     * history is weighed first and admitted against its namespace's repo
     * bytes: over what is left it is QuotaExceeded, over what one relay
     * carries ImportTooLarge, and either way trunk is given no head and
     * nothing is counted. Any other start is counted and never refused.
     */
    readonly initialize: (
      projectId: ProjectId,
      head: CommitSha,
      by: string,
      origin: TrunkOrigin,
    ) => Effect.Effect<void, PromotionStateRefused | QuotaExceeded | ImportTooLarge>;
    /**
     * Where trunk started, as its TrunkInitialized recorded it: none for a
     * trunk initialized before origins were kept. Dies for a trunk not yet
     * initialized.
     */
    readonly origin: (projectId: ProjectId) => Effect.Effect<Option.Option<TrunkOrigin>>;
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
