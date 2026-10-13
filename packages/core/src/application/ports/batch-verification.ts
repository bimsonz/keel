import { Context, type Effect } from "effect";
import type {
  CandidateId,
  ContentHash,
  NamespaceId,
  ProjectId,
} from "../../domain/kernel/index.ts";
import type { CandidateFence } from "./batch-verdicts.ts";

/** What KeelVerify runs: one batch's bundled candidate under one plan, fenced to the batch's attempt. */
export interface VerificationJob {
  /** The lane's project, and the namespace it belongs to, where the candidate's bundle and its plan are kept. KeelVerify reads the project's namespace again and refuses a job that names another. */
  readonly projectId: ProjectId;
  readonly namespace: NamespaceId;
  readonly jobId: string;
  readonly laneId: string;
  readonly candidateId: CandidateId;
  readonly bundle: ContentHash;
  readonly fence: CandidateFence;
  readonly planHash: ContentHash;
}

/**
 * How a KeelVerify instance stands, read from the platform that runs it.
 * `Running` is every state that may still end in a verdict (queued, paused
 * and waiting among them). `Completed` ran to its end, so its verdict was
 * recorded. `Failed` will never record one: it ended in error, was
 * terminated, was never made (`missing`), or stands in a state the platform
 * does not name. `error` is the instance's own message, already redacted and
 * cut to 200 characters by the adapter that read it.
 */
export type InstanceStanding =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Completed" }
  | {
      readonly _tag: "Failed";
      readonly status: "errored" | "terminated" | "missing" | "unknown";
      readonly error?: string;
    };

/**
 * Starts KeelVerify for a batch. The instance id is the caller's (the Lane's
 * `instanceOf`, which names the lane and the batch's BatchFormed), and
 * starting an instance that already exists succeeds without starting another,
 * so a retried step is idempotent. The verdict comes back through
 * `BatchVerdicts`. An instance that will never send one is found by
 * `standing`, and `stop` ends one that outran its budget: stopping an
 * instance that has ended, or was never made, does nothing.
 */
export class BatchVerification extends Context.Service<
  BatchVerification,
  {
    readonly start: (instanceId: string, job: VerificationJob) => Effect.Effect<void>;
    readonly standing: (instanceId: string) => Effect.Effect<InstanceStanding>;
    readonly stop: (instanceId: string) => Effect.Effect<void>;
  }
>()("keel/BatchVerification") {}
