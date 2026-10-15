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
import {
  BatchAttribution,
  MemberCommit,
  PromotionFrozenReason,
  SyncUpstream,
  TrunkOrigin,
} from "./events.ts";

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

/**
 * How many changes a batch of `n` lands per verification when each member
 * fails on its own with probability `p`, and a failed batch of several runs
 * every member alone next (a failure no one is blamed for): it lands n(1 − p)
 * over 1 + (1 − (1 − p)^n)·n verifications, and a batch of one lands 1 − p
 * over one. `expm1` and `log1p` keep tiny rates exact.
 */
export const landedPerVerification = (p: number, n: number): number =>
  n <= 1 ? 1 - p : (n * (1 - p)) / (1 - Math.expm1(n * Math.log1p(-p)) * n);

/**
 * Batch size from the recent failure rate: the `n` in 1..`queued` that lands
 * the most changes per verification (`landedPerVerification`), the smallest
 * of any tie. Nothing else bounds it: with no failures each size lands more
 * than the last, so it is the whole queue. Where every change fails no size
 * lands any, and an unknown rate (NaN) compares as no gain: both stay at one.
 */
export function batchSize(failureRate: number, queued: number): number {
  const most = Math.max(1, Math.floor(queued));
  let best = 1;
  let landed = landedPerVerification(failureRate, 1);
  for (let n = 2; n <= most; n++) {
    const each = landedPerVerification(failureRate, n);
    if (each > landed) {
      best = n;
      landed = each;
    }
  }
  return best;
}

export const PromotionState = Schema.Literals([
  "idle",
  "debouncing",
  "promoting",
  "frozen",
  "syncing",
]);
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
  /** Each member's commit in the composed chain, recorded with `composed`. */
  commits: Schema.optional(Schema.Array(MemberCommit)),
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
  /**
   * Every batch speculation cancelled before it promoted: a verdict for one
   * that arrives later is refused, so it never promotes. Absent until the first.
   */
  dropped: Schema.optional(Schema.Array(BatchId)),
  /** How many times Keel has advanced trunk since TrunkInitialized; absent in state folded before it was kept. */
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Where trunk started, as TrunkInitialized said it; absent on a trunk initialized before origins were kept. */
  origin: Schema.optional(TrunkOrigin),
  /**
   * When trunk's head last changed: the commit time of its TrunkInitialized,
   * of each TrunkAdvanced, and of a PromotionResumed that took another head.
   * Absent in state folded before it was kept, until the next of those.
   */
  advancedAt: Schema.optional(InstantSchema),
  wal: Schema.optional(PendingGroup),
  /**
   * Set once a group of several batches was refused as too large a pack:
   * each group is then one batch, until a push lands.
   */
  solo: Schema.optional(Schema.Literal(true)),
  /** The open sync from upstream, from its TrunkSyncStarted until TrunkSynced or a freeze resolves it. */
  sync: Schema.optional(
    Schema.Struct({ from: CommitSha, to: CommitSha, by: Schema.String, upstream: SyncUpstream }),
  ),
  frozen: Schema.optional(
    Schema.Struct({
      expected: CommitSha,
      observed: CommitSha,
      reason: Schema.optional(PromotionFrozenReason),
    }),
  ),
});
export type Trunk = typeof Trunk.Type;
