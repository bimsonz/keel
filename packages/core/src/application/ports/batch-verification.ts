import { Context, type Effect } from "effect";
import type { CandidateId, ContentHash } from "../../domain/kernel/index.ts";
import type { CandidateFence } from "./batch-verdicts.ts";

/** What KeelVerify runs: one batch's bundled candidate under one plan, fenced to the batch's attempt. */
export interface VerificationJob {
  readonly jobId: string;
  readonly laneId: string;
  readonly candidateId: CandidateId;
  readonly bundle: ContentHash;
  readonly fence: CandidateFence;
  readonly planHash: ContentHash;
}

/**
 * Starts KeelVerify for a batch. The instance id is the caller's
 * (`keel-verify-<BatchFormed eventId>`), and starting an instance that already
 * exists succeeds without starting another, so a retried step is idempotent.
 * The verdict comes back through `BatchVerdicts`.
 */
export class BatchVerification extends Context.Service<
  BatchVerification,
  {
    readonly start: (instanceId: string, job: VerificationJob) => Effect.Effect<void>;
  }
>()("keel/BatchVerification") {}
