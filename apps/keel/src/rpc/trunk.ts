import {
  NotFastForward,
  NotImported,
  PromotionState,
  PromotionStateRefused,
  TrunkNotInitialized,
  TrunkOrigin,
} from "@keeltown/core/domain/integration";
import { QuotaExceeded } from "@keeltown/core/domain/identity";
import {
  BatchId,
  ChangeId,
  type CommandActor,
  CommitSha,
  InstantSchema,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";
import { ImportTooLarge, RepoNotFound } from "./project.ts";
import { RepoRef } from "./workspace-pool.ts";

export const TrunkStatus = Schema.Struct({
  head: CommitSha,
  promotion: PromotionState,
  /** Where trunk started; absent on a trunk initialized before origins were kept. */
  origin: Schema.optional(TrunkOrigin),
});

/** A trunk as a reader of its project is shown it: nothing for a trunk with no head yet. */
export const TrunkStandingAnswer = Schema.Struct({
  trunk: Schema.optional(
    Schema.Struct({ head: CommitSha, phase: PromotionState, advancedAt: InstantSchema }),
  ),
});

/** Where trunk started: no origin for a trunk with no head yet, or one initialized before origins were kept. */
export const TrunkStart = Schema.Struct({ origin: Schema.optional(TrunkOrigin) });

/** What one sync did to a repo: it already held trunk's head, or its main moved there. */
export const SyncOutcome = Schema.Literals(["unchanged", "advanced"]);

/** Trunk's head, and what copying it did to staging and the mirror. */
export const TrunkSync = Schema.Struct({
  head: CommitSha,
  staging: SyncOutcome,
  mirror: SyncOutcome,
});

/** The TrunkWriter port's PackTooLarge, by shape (rule R15): a relayed pack over the receive-pack cap. */
export const PackTooLarge = Schema.TaggedStruct("PackTooLarge", {
  repo: RepoRef,
  bytes: Schema.Number,
  limit: Schema.Number,
});

/** What a sync from upstream did: trunk moved `from → to`, or was already level with upstream (`synced` false, `from` and `to` alike). */
export const UpstreamSyncedAnswer = Schema.Struct({
  from: CommitSha,
  to: CommitSha,
  synced: Schema.Boolean,
});

/** The Trunks port's UpstreamUnreachable, by shape (rule R15). */
export const UpstreamUnreachable = Schema.TaggedStruct("UpstreamUnreachable", {
  url: Schema.String,
  ref: Schema.String,
  reason: Schema.Literals(["unreachable", "branch-gone"]),
});

/** A batch speculation cancels, behind the failed batch `because`, with its members. */
export const BatchCancel = Schema.Struct({
  batchId: BatchId,
  because: BatchId,
  members: Schema.Array(ChangeId),
});

/** What the trunk made of a cancel: dropped, or too late for a batch being pushed or landed. */
export const CancelAnswer = Schema.Union([
  Schema.TaggedStruct("dropped", {}),
  Schema.TaggedStruct("too-late", { reason: Schema.Literals(["promoting", "promoted"]) }),
]);

export const TrunkCodecs = {
  status: exitCodec(TrunkStatus, Schema.Never),
  origin: exitCodec(TrunkStart, Schema.Never),
  view: exitCodec(TrunkStandingAnswer, Schema.Never),
  resume: exitCodec(TrunkStatus, Schema.Never),
  initialize: exitCodec(
    TrunkStatus,
    Schema.Union([PromotionStateRefused, QuotaExceeded, ImportTooLarge]),
  ),
  adopt: exitCodec(Schema.Void, Schema.Never),
  seed: exitCodec(CommitSha, Schema.Never),
  take: exitCodec(CommitSha, Schema.Union([RepoNotFound, ImportTooLarge])),
  sync: exitCodec(TrunkSync, Schema.Union([RepoNotFound, PackTooLarge])),
  syncUpstream: exitCodec(
    UpstreamSyncedAnswer,
    Schema.Union([
      TrunkNotInitialized,
      NotImported,
      NotFastForward,
      PromotionStateRefused,
      UpstreamUnreachable,
      ImportTooLarge,
      QuotaExceeded,
    ]),
  ),
  cancel: exitCodec(CancelAnswer, TrunkNotInitialized),
  destroy: exitCodec(Schema.Void, Schema.Never),
};

/** The Trunk DO (`trunk:<project>`): the one writer of trunk. Promotion is driven by `BatchVerified`, not by RPC. */
export interface TrunkRpc {
  status(): Promise<ExitJson>;
  /** Where trunk started, for a reader of the project: answers a trunk with no head yet too, with no origin. */
  origin(): Promise<ExitJson>;
  /**
   * The trunk as a reader of the project is shown it: its head, when that
   * last changed (the time of the event that put it there) and its
   * promotion's phase. Answers a trunk with no head yet too, with nothing.
   */
  view(): Promise<ExitJson>;
  /** Releases a frozen promotion. Operator only. */
  resume(by: CommandActor): Promise<ExitJson>;
  /**
   * Names trunk's first head and where it came from (the Project DO's
   * createProject, once it has created trunk). A retry with the same head
   * answers the trunk; another head, or any head once trunk has one, is
   * PromotionStateRefused. An origin naming another commit is a defect. An
   * imported history over its namespace's repo bytes is QuotaExceeded, and
   * one over what a relay carries ImportTooLarge: trunk then has no head.
   */
  initialize(
    head: typeof CommitSha.Encoded,
    by: string,
    origin: typeof TrunkOrigin.Encoded,
  ): Promise<ExitJson>;
  /**
   * Makes main at `commit` in a trunk that was imported under another
   * branch's name (the Project DO's createProject, before `initialize`). No
   * object is sent. A defect once trunk is initialized.
   */
  adopt(commit: typeof CommitSha.Encoded): Promise<ExitJson>;
  /**
   * Writes an empty trunk's first commit, made of the project's `name` and
   * the time `at` alone, and answers it (the Project DO's createProject,
   * before `initialize`). A defect once trunk is initialized.
   */
  seed(name: string, at: typeof InstantSchema.Encoded): Promise<ExitJson>;
  /**
   * Brings an empty trunk the whole history of the project `source`'s trunk
   * and answers the head it now has (the Project DO's createProject for a
   * fork, before `initialize`). A trunk that has a main answers it and takes
   * nothing. A source with no trunk repo is RepoNotFound, and one over what
   * a relay carries ImportTooLarge. A defect once trunk is initialized.
   */
  take(source: string): Promise<ExitJson>;
  /**
   * Copies trunk's head into the project's staging and mirror (relaying
   * trunk's pack, so commit ids survive). Idempotent; the Project DO's
   * createProject calls it once, after `initialize`. After each TrunkAdvanced
   * the Trunk DO syncs only the mirror, off the promotion path: staging's main
   * has one writer, the Lane.
   */
  sync(): Promise<ExitJson>;
  /**
   * Moves an imported trunk's main forward to the head of the upstream
   * branch its import took, as `by`, an owner, asked: refused, with nothing
   * moved, when trunk was not imported, is not between groups, upstream
   * cannot be read, its head does not descend from trunk's, or its new
   * history is over what a relay carries or over the namespace's repo
   * bytes. A move the code host keeps busy is finished on the Trunk DO's
   * own deadline, and answers `synced` false until then.
   */
  syncUpstream(by: CommandActor): Promise<ExitJson>;
  /**
   * Cancels a batch speculation verified behind a failed one: `dropped` when
   * it was queued here or its verdict has not arrived (it never promotes),
   * `too-late` when it is being pushed or a member landed. Idempotent.
   */
  cancel(cancel: typeof BatchCancel.Encoded): Promise<ExitJson>;
  /**
   * Destroys the trunk for good, when its project is deleted: it takes no
   * batch and promotes nothing from here on, and deletes the project's trunk,
   * staging, mirror and guards repos on a deadline of its own, retried until
   * none is left. Idempotent. The caller commits ProjectDeleted first, so
   * whatever is refused here meets the gate's 404 for the project on a retry.
   */
  destroy(by: string): Promise<ExitJson>;
}
