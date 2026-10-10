import { Batch, CandidateNotFound } from "@keeltown/core/domain/integration";
import type { ChangeId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

export const LaneCodecs = {
  enqueue: exitCodec(Schema.Struct({ position: Schema.Int }), Schema.Never),
  batch: exitCodec(Batch, CandidateNotFound),
};

/** The Lane DO (`lane:<project>:<id>`): the queue, batching, bisection, textual and interaction conflicts. */
export interface LaneRpc {
  enqueue(changeId: typeof ChangeId.Encoded): Promise<ExitJson>;
  batch(batchId: string): Promise<ExitJson>;
}
