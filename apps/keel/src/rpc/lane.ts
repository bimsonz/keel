import { Batch, CandidateNotFound, ResultFenced } from "@keeltown/core/domain/integration";
import { VerdictOutcome } from "@keeltown/core/domain/verification";
import { BatchId, CandidateId, ContentHash, NextAction, VerdictId } from "@keeltown/core/kernel";
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
  /** On a bounce, the remedy KeelVerify read from the evidence, for the lane's VerdictIssued. Absent otherwise. */
  nextActions: Schema.optionalKey(Schema.Array(NextAction)),
});
export type RecordVerdictCommand = typeof RecordVerdictCommand.Type;

/** The platform's report that a KeelVerify instance ended without completing: the instance, nothing more. */
export const VerificationEndedCommand = Schema.Struct({ instanceId: Schema.NonEmptyString });
export type VerificationEndedCommand = typeof VerificationEndedCommand.Type;

export const LaneCodecs = {
  batch: exitCodec(Batch, CandidateNotFound),
  recordVerdict: exitCodec(Schema.Void, Schema.Union([ResultFenced, CandidateNotFound])),
  destroy: exitCodec(Schema.Void, Schema.Never),
  verificationEnded: exitCodec(Schema.Void, Schema.Never),
};

/**
 * The Lane DO (`lane:<project>:<id>`): the queue, batching, bisection, textual
 * and interaction conflicts. A change joins the queue by its ChangeQueued, never
 * by a call.
 */
export interface LaneRpc {
  batch(batchId: string): Promise<ExitJson>;
  recordVerdict(command: typeof RecordVerdictCommand.Encoded): Promise<ExitJson>;
  /**
   * Stops the lane for good, when its project is deleted: it drops its queue
   * and its batch in flight and cancels its deadlines, so it forms no batch
   * and re-offers none to trunk, and from here on it hears no event and takes
   * no verdict (CandidateNotFound). Idempotent. The caller commits
   * ProjectDeleted first, as for `TrunkRpc.destroy`.
   */
  destroy(by: string): Promise<ExitJson>;
  /**
   * The platform reported that a KeelVerify instance ended without
   * completing. A hint: the lane reads that instance's standing itself, and
   * only for its own batch in flight while it verifies. One that will send no
   * verdict fails its batch on the infrastructure, so its change is verified
   * afresh, and bounced with next actions the third time in a row. A
   * duplicate, a late or a stray report changes nothing.
   */
  verificationEnded(command: typeof VerificationEndedCommand.Encoded): Promise<ExitJson>;
}
