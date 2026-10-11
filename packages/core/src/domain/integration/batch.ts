import { Schema } from "effect";
import {
  BatchId,
  CandidateId,
  ChangeId,
  CommitSha,
  InstantSchema,
  ProjectId,
  VerdictId,
} from "../kernel/index.ts";
import { BatchAttribution } from "./events.ts";

export const CandidateState = Schema.Literals([
  "forming",
  "assembled",
  "verifying",
  "green",
  "red",
  "bisected",
  "promoted",
  "invalidated",
]);
export type CandidateState = typeof CandidateState.Type;

/** A set of changes from one lane, composed into one candidate and verified together. */
export const Batch = Schema.Struct({
  id: BatchId,
  laneId: Schema.String,
  projectId: ProjectId,
  members: Schema.Array(ChangeId),
  base: CommitSha,
  attempt: Schema.Int,
  chainEpoch: Schema.Int,
  candidateId: Schema.optional(CandidateId),
  state: CandidateState,
  /** The speculation chain it was verified on top of. */
  predecessors: Schema.optional(Schema.Array(ChangeId)),
  /** Who a Red batch is blamed on. */
  attribution: Schema.optional(BatchAttribution),
});
export type Batch = typeof Batch.Type;

/** The largest batch a lane forms. */
export const MAX_BATCH = 16;

/**
 * Batch size from the recent failure rate: N = clamp(ln 0.8 / ln(1 − p), 1, 16),
 * the largest batch that still passes whole with probability 0.8. An unknown
 * rate (NaN) is treated as the worst case. `log1p` keeps tiny rates exact:
 * `1 − p` would round to 1 and divide by zero.
 */
export function batchSize(failureRate: number): number {
  if (Number.isNaN(failureRate) || failureRate >= 1) return 1;
  if (failureRate <= 0) return MAX_BATCH;
  const n = Math.floor(Math.log(0.8) / Math.log1p(-failureRate));
  return Math.min(MAX_BATCH, Math.max(1, n));
}

export const PromotionState = Schema.Literals(["idle", "debouncing", "promoting", "frozen"]);
export type PromotionState = typeof PromotionState.Type;

/** A verified batch waiting at the Trunk DO, in arrival order. */
export const QueuedBatch = Schema.Struct({
  batchId: BatchId,
  candidateId: CandidateId,
  verdictId: VerdictId,
  members: Schema.Array(ChangeId),
  base: CommitSha,
  predecessors: Schema.Array(ChangeId),
  /** The `BatchVerified.verified` it arrived with. Absent means true. */
  verified: Schema.optional(Schema.Boolean),
});
export type QueuedBatch = typeof QueuedBatch.Type;

/** Whether a verdict, batch or advance was reached by running its plan: only an explicit `false` says no. */
export const isVerified = (x: { readonly verified?: boolean | undefined }): boolean =>
  x.verified !== false;

/** The open write-ahead log entry: the group being pushed, and once composed, the one SHA every retry pushes. */
export const PendingGroup = Schema.Struct({
  groupId: Schema.String,
  old: CommitSha,
  batches: Schema.Array(QueuedBatch),
  proofIds: Schema.Array(Schema.String),
  committerTime: InstantSchema,
  composed: Schema.optional(CommitSha),
});
export type PendingGroup = typeof PendingGroup.Type;

/** The Trunk DO's state: the one writer of trunk (ADR 0003). */
export const Trunk = Schema.Struct({
  projectId: ProjectId,
  phase: PromotionState,
  head: CommitSha,
  queue: Schema.Array(QueuedBatch),
  /** Every change promoted so far, for commutation's wait check. */
  promoted: Schema.Array(ChangeId),
  wal: Schema.optional(PendingGroup),
  frozen: Schema.optional(Schema.Struct({ expected: CommitSha, observed: CommitSha })),
});
export type Trunk = typeof Trunk.Type;
