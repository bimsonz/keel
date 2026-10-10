import { PromotionState, PromotionStateRefused } from "@keeltown/core/domain/integration";
import { CommitSha } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

export const TrunkStatus = Schema.Struct({
  head: CommitSha,
  promotion: PromotionState,
  redCount: Schema.Int,
});

export const TrunkCodecs = {
  status: exitCodec(TrunkStatus, Schema.Never),
  resume: exitCodec(TrunkStatus, Schema.Never),
  initialize: exitCodec(TrunkStatus, PromotionStateRefused),
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
}
