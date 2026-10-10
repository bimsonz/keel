import { Schema } from "effect";
import { BatchId, CandidateId, ChangeId, CommitSha, ProjectId } from "../kernel/index.ts";

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
