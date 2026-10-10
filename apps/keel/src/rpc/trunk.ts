import { PromotionState } from "@keeltown/core/domain/integration";
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
};

/** The Trunk DO (`trunk:<project>`): the one writer of trunk. Promotion is driven by `BatchVerified`, not by RPC. */
export interface TrunkRpc {
  status(): Promise<ExitJson>;
  /** Releases a frozen promotion. Operator only. */
  resume(by: string): Promise<ExitJson>;
}
