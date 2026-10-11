import { PromotionState, PromotionStateRefused } from "@keeltown/core/domain/integration";
import { CommitSha } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";
import { RepoNotFound } from "./project.ts";
import { RepoRef } from "./workspace-pool.ts";

export const TrunkStatus = Schema.Struct({
  head: CommitSha,
  promotion: PromotionState,
  redCount: Schema.Int,
});

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

export const TrunkCodecs = {
  status: exitCodec(TrunkStatus, Schema.Never),
  resume: exitCodec(TrunkStatus, Schema.Never),
  initialize: exitCodec(TrunkStatus, PromotionStateRefused),
  sync: exitCodec(TrunkSync, Schema.Union([RepoNotFound, PackTooLarge])),
};

/** The Trunk DO (`trunk:<project>`): the one writer of trunk. Promotion is driven by `BatchVerified`, not by RPC. */
export interface TrunkRpc {
  status(): Promise<ExitJson>;
  /** Releases a frozen promotion. Operator only. */
  resume(by: string): Promise<ExitJson>;
  /**
   * Names trunk's first head (the Project DO's createProject, once it has
   * created trunk). A retry with the same head answers the trunk; another
   * head, or any head once trunk has one, is PromotionStateRefused.
   */
  initialize(head: typeof CommitSha.Encoded, by: string): Promise<ExitJson>;
  /**
   * Copies trunk's head into the project's staging and mirror (relaying
   * trunk's pack, so commit ids survive). Idempotent; the Project DO's
   * createProject calls it after `initialize`, and the Trunk DO runs it after
   * each TrunkAdvanced, off the promotion path.
   */
  sync(): Promise<ExitJson>;
}
