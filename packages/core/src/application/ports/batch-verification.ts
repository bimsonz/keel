import { Context, type Effect } from "effect";
import type { CandidateId, ContentHash, OrgId, ProjectId } from "../../domain/kernel/index.ts";
import type { CandidateFence } from "./batch-verdicts.ts";

/** What KeelVerify runs: one batch's bundled candidate under one plan, fenced to the batch's attempt. */
export interface VerificationJob {
  /** The lane's project, and the namespace it belongs to, where the candidate's bundle and its plan are kept. KeelVerify reads the project's namespace again and refuses a job that names another. */
  readonly projectId: ProjectId;
  readonly namespace: OrgId;
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
