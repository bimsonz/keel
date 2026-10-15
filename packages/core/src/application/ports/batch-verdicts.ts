import { Context, type Effect } from "effect";
import type {
  CandidateNotFound,
  ResultFenced,
  StepReported,
} from "../../domain/integration/index.ts";
import type {
  BatchId,
  CandidateId,
  ContentHash,
  Instant,
  NextAction,
  VerdictId,
} from "../../domain/kernel/index.ts";
import type { VerdictOutcome } from "../../domain/verification/index.ts";

/** Which attempt a verification result belongs to, exactly as the Candidate machine fences it. */
export interface CandidateFence {
  readonly batchId: BatchId;
  readonly attempt: number;
  readonly chainEpoch: number;
}

/** KeelVerify's verdict on a batch's candidate, for the lane that formed the batch. */
export interface BatchVerdict {
  /** The KeelVerify instance: a replayed step records nothing new. */
  readonly instanceId: string;
  readonly fence: CandidateFence;
  readonly candidateId: CandidateId;
  readonly verdictId: VerdictId;
  readonly outcome: VerdictOutcome;
  readonly planHash: ContentHash;
  /** One line per step result the outcome rests on, citing where its evidence is stored. */
  readonly evidence: readonly string[];
  /** The failing tests' full names, for the lane's attribution. */
  readonly failingTests: readonly string[];
  /** On a bounce, what the change's agent can do about it: the lane copies them into its VerdictIssued. */
  readonly nextActions?: readonly NextAction[];
  /**
   * Set on a park that rests only on steps the verifier could not run for
   * want of capacity (rate-limited): it says nothing about the change, so the lane
   * counts it toward no member's infra limit and runs no member alone for it.
   */
  readonly unrun?: true;
  /** On a park for want of quota, when the namespace's limit resets: the lane forms nothing before it. */
  readonly retryAt?: Instant;
  /**
   * Set on a bounce because the namespace's verification spend is stopped: every
   * member bounces, and none of them is blamed, counted or run alone for it.
   */
  readonly halted?: true;
}

/** KeelVerify's report of one step of a batch's plan, as it runs: that it started, or its result. */
export interface BatchStepReport {
  /** The KeelVerify instance: a replayed report records nothing new. */
  readonly instanceId: string;
  readonly fence: CandidateFence;
  readonly candidateId: CandidateId;
  readonly step: StepReported;
}

/**
 * Where KeelVerify reports a verdict: the Lane DO that formed the batch, which
 * commits VerdictIssued with BatchVerified or BatchFailed, attributing a
 * failure itself. A result for a stale attempt or chain epoch is ResultFenced,
 * which is terminal. Each step is reported there too, as it starts and as it
 * finishes; one for a batch no longer verifying is ResultFenced as well.
 */
export class BatchVerdicts extends Context.Service<
  BatchVerdicts,
  {
    readonly record: (
      laneId: string,
      verdict: BatchVerdict,
    ) => Effect.Effect<void, ResultFenced | CandidateNotFound>;
    readonly recordStep: (
      laneId: string,
      step: BatchStepReport,
    ) => Effect.Effect<void, ResultFenced | CandidateNotFound>;
  }
>()("keel/BatchVerdicts") {}
