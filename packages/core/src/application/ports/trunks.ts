import { Context, type Effect, type Option, Schema } from "effect";
import type { QuotaExceeded } from "../../domain/identity/index.ts";
import type {
  NotFastForward,
  NotImported,
  PromotionState,
  PromotionStateRefused,
  TrunkNotInitialized,
  TrunkOrigin,
} from "../../domain/integration/index.ts";
import type {
  BatchId,
  ChangeId,
  CommandActor,
  CommitSha,
  Instant,
  ProjectId,
} from "../../domain/kernel/index.ts";
import type { RepoNotFound } from "./code-host.ts";

/** A batch speculation cancels, behind the failed batch `because`, with its members. */
export interface BatchCancel {
  readonly batchId: BatchId;
  readonly because: BatchId;
  readonly members: readonly ChangeId[];
}

/**
 * What the trunk made of a cancel. `dropped`: the batch left the queue, or
 * was remembered before its verdict arrived, and never promotes; its members
 * may be queued again. `too-late`: it is in the group being pushed
 * (`promoting`), or a member of it landed (`promoted`); it lands or fails with
 * that group, and its members are not queued again.
 */
export type CancelAnswer =
  | { readonly _tag: "dropped" }
  | { readonly _tag: "too-late"; readonly reason: "promoting" | "promoted" };

/**
 * A history too large to start a project from, imported or forked: its one
 * pack is over what a relay carries (`limit`), so staging and the mirror
 * could never be brought to trunk's head. Trunk was given no head. An
 * import's `bytes` are what its history weighs; a fork's are what the relay
 * had read of its source when it stopped, which is only known to be over.
 */
export class ImportTooLarge extends Schema.TaggedError<ImportTooLarge>()("ImportTooLarge", {
  projectId: Schema.String,
  bytes: Schema.Number,
  limit: Schema.Number,
}) {}

/** Where a sync left the project's repos: trunk's head, and staging and the mirror brought to it. */
export interface ReposSynced {
  readonly head: CommitSha;
  readonly staging: CommitSha;
  readonly mirror: CommitSha;
}

/** Upstream could not be read: its URL answered nothing Keel could use, or the branch the import took is gone. */
export class UpstreamUnreachable extends Schema.TaggedError<UpstreamUnreachable>()(
  "UpstreamUnreachable",
  {
    url: Schema.String,
    ref: Schema.String,
    reason: Schema.Literals(["unreachable", "branch-gone"]),
  },
) {}

/** What a sync from upstream did: trunk moved `from → to`, or was already at upstream's head (`synced` false, `from` and `to` the same). */
export interface UpstreamSynced {
  readonly from: CommitSha;
  readonly to: CommitSha;
  readonly synced: boolean;
}

/** Why a sync from upstream moved nothing. */
export type SyncRefused =
  | TrunkNotInitialized
  | NotImported
  | NotFastForward
  | PromotionStateRefused
  | UpstreamUnreachable
  | ImportTooLarge
  | QuotaExceeded;

/** A trunk as a reader of its project is shown it: its head, when that last changed, and what its promotion is doing. */
export interface TrunkStanding {
  readonly head: CommitSha;
  readonly phase: PromotionState;
  /** When `head` last changed: the commit time of the event that put it there. */
  readonly advancedAt: Instant;
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
     * trunk initialized before origins were kept, and for one with no head
     * yet.
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
     * Brings an empty trunk the whole history of `source`'s trunk and makes
     * main at its head, through the trunk's one writer (`TrunkWriter.take`),
     * and answers that head: how a fork starts. A trunk that already has a
     * main answers it and takes nothing. A source with no trunk repo is
     * RepoNotFound, and one whose history is over what one relay carries
     * ImportTooLarge, as an import of that size is: either way nothing was
     * written. A first write: asked of a trunk that is already initialized it
     * is a defect.
     */
    readonly take: (
      projectId: ProjectId,
      source: ProjectId,
    ) => Effect.Effect<CommitSha, RepoNotFound | ImportTooLarge>;
    /**
     * Trunk's head as its Trunk DO records it: what the Lane composes onto,
     * never a ref read that may lag or lead it. Dies for a trunk not yet
     * initialized, since no change exists in such a project.
     */
    readonly head: (projectId: ProjectId) => Effect.Effect<CommitSha>;
    /**
     * The trunk as a reader is shown it: none for a trunk with no head yet,
     * which is never a defect here. `advancedAt` is the time of the event that
     * last changed `head` (TrunkInitialized, a TrunkAdvanced, or a resume at
     * another head), and no other event of the trunk's changes it.
     */
    readonly view: (projectId: ProjectId) => Effect.Effect<Option.Option<TrunkStanding>>;
    /**
     * Moves trunk's main forward to the head of the upstream branch its import
     * took, as its owner asked, keeping each upstream commit as it is. Only
     * an imported trunk has an upstream (NotImported otherwise), and only one
     * whose head upstream's descends from moves (NotFastForward otherwise,
     * naming both). It starts between groups only (PromotionStateRefused
     * while a group is in flight, a freeze holds or another sync is open).
     * Upstream's new history is weighed and admitted against the namespace's
     * repo bytes first: over what one relay carries it is ImportTooLarge, over
     * what is left QuotaExceeded. Each refusal moves nothing. Upstream already
     * at trunk's head answers `synced: false` and records nothing.
     */
    readonly syncUpstream: (
      projectId: ProjectId,
      by: CommandActor,
    ) => Effect.Effect<UpstreamSynced, SyncRefused>;
    /**
     * Cancels a batch speculation verified behind a failed one, whether it is
     * queued at the trunk or its verdict has not arrived yet: `dropped` means
     * it never promotes, and only then may its members be queued again.
     * Idempotent: a dropped batch is answered `dropped` again.
     */
    readonly cancel: (
      projectId: ProjectId,
      cancel: BatchCancel,
    ) => Effect.Effect<CancelAnswer, TrunkNotInitialized>;
    /** Brings staging and the project's mirror to trunk's head. Idempotent. */
    readonly sync: (projectId: ProjectId) => Effect.Effect<ReposSynced>;
    /**
     * Destroys the project's trunk, for good (its project was deleted): it
     * promotes nothing from here on, and its trunk, staging, mirror and guards
     * repos are deleted, retried until none is left. Idempotent.
     */
    readonly destroy: (projectId: ProjectId, by: string) => Effect.Effect<void>;
  }
>()("keel/Trunks") {}
