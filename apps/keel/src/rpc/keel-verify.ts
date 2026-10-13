import { BatchId, CandidateId, ContentHash, OrgId, ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";

/** The source-control provider id KeelVerify's runs carry: candidates come from bundles, never from git. */
export const KEEL_BUNDLE_PROVIDER = "keel-bundle";

/**
 * One KeelVerify run: verify the candidate `bundle` of the lane's batch under
 * `planHash`, both kept for `namespace`, the namespace `projectId` belongs
 * to, and report back to `laneId` fenced on `fence`. Workflow payload, so
 * Effect Schema; the instance id is `keel-verify-<eventId>` of the event that
 * started it.
 */
export const KeelVerifyJob = Schema.Struct({
  projectId: ProjectId,
  namespace: OrgId,
  jobId: Schema.NonEmptyString,
  laneId: Schema.NonEmptyString,
  candidateId: CandidateId,
  bundle: ContentHash,
  fence: Schema.Struct({ batchId: BatchId, attempt: Schema.Int, chainEpoch: Schema.Int }),
  planHash: ContentHash,
});
export type KeelVerifyJob = typeof KeelVerifyJob.Type;

/**
 * The full payload to create a KeelVerify instance with: the job, plus the
 * fields @cloudflare/ci's engine reads before `pipeline()`. The engine fixes
 * where every runner fetches its checkout from `providerData`, here, before
 * any step runs: so the payload names the namespace, and the instance's
 * `namespace` step refuses to run when the project belongs to another. `ref`
 * is the engine's cache scope, so it names the candidate: candidate code
 * never runs under the base's scope (ADR 0007).
 */
export const keelVerifyParams = (job: KeelVerifyJob) => ({
  ...Schema.encodeSync(KeelVerifyJob)(job),
  provider: KEEL_BUNDLE_PROVIDER,
  providerData: { namespace: job.namespace, bundle: job.bundle },
  event: { type: "batch" },
  owner: "keel",
  repo: job.laneId,
  sha: job.bundle.slice("sha256:".length),
  trigger: "push" as const,
  ref: `refs/keel/candidates/${job.candidateId}`,
});
