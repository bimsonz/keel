import { Batch, CandidateNotFound, ResultFenced } from "@keeltown/core/domain/integration";
import { VerdictOutcome } from "@keeltown/core/domain/verification";
import { BatchId, CandidateId, ContentHash, VerdictId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

/**
 * KeelVerify's verdict on the batch's candidate. The lane commits VerdictIssued
 * with BatchVerified (a land) or BatchFailed (anything else, attributed by the
 * lane from `failingTests`) in one transaction, through the Candidate machine.
 * Idempotent by `instanceId` (cause `<instanceId>:recordVerdict`). A result
 * for another attempt or chain epoch is ResultFenced, which is terminal.
 */
export const RecordVerdictCommand = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  fence: Schema.Struct({ batchId: BatchId, attempt: Schema.Int, chainEpoch: Schema.Int }),
  candidateId: CandidateId,
  verdictId: VerdictId,
  outcome: VerdictOutcome,
  planHash: ContentHash,
  evidence: Schema.Array(Schema.String),
  failingTests: Schema.Array(Schema.String),
});
export type RecordVerdictCommand = typeof RecordVerdictCommand.Type;

export const LaneCodecs = {
  batch: exitCodec(Batch, CandidateNotFound),
  recordVerdict: exitCodec(Schema.Void, Schema.Union([ResultFenced, CandidateNotFound])),
};

/**
 * The Lane DO (`lane:<project>:<id>`): the queue, batching, bisection, textual
 * and interaction conflicts. A change joins the queue by its ChangeQueued, never
 * by a call.
 */
export interface LaneRpc {
  batch(batchId: string): Promise<ExitJson>;
  recordVerdict(command: typeof RecordVerdictCommand.Encoded): Promise<ExitJson>;
}
