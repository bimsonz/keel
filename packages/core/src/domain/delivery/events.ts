import { Schema } from "effect";
import {
  CandidateId,
  ChangeId,
  CommitSha,
  CredentialId,
  DeploymentId,
  NamespaceId,
  ProjectId,
  UserId,
} from "../kernel/index.ts";
import { CredentialMeta } from "./credential.ts";
import { DeployProvider, DeployTarget, DeployTargetName } from "./deployment.ts";

/**
 * An owner stored a credential in the namespace's store. The record is what
 * anyone may read of it: the secret was sealed before this was committed, and
 * no event carries it.
 */
export const CredentialStored = Schema.TaggedStruct("CredentialStored", {
  namespaceId: NamespaceId,
  credential: CredentialMeta,
  by: UserId,
});
/** An owner removed a credential from the namespace's store: its sealed secret is gone with it. */
export const CredentialRemoved = Schema.TaggedStruct("CredentialRemoved", {
  namespaceId: NamespaceId,
  credentialId: CredentialId,
  by: UserId,
});

/** An owner set one of the project's deploy targets, new or in place of the one of that name. */
export const DeployTargetSet = Schema.TaggedStruct("DeployTargetSet", {
  projectId: ProjectId,
  /** The whole record as it now stands: its credential is a reference, never the secret. */
  target: DeployTarget,
  by: UserId,
});
/** An owner removed one of the project's deploy targets. */
export const DeployTargetCleared = Schema.TaggedStruct("DeployTargetCleared", {
  projectId: ProjectId,
  name: DeployTargetName,
  by: UserId,
});

/**
 * A candidate's preview went up. KeelVerify's preview step commits one on each
 * member change's stream, so the agent working the change reads it in its
 * inbox.
 */
export const PreviewDeployed = Schema.TaggedStruct("PreviewDeployed", {
  deploymentId: DeploymentId,
  changeId: ChangeId,
  candidateId: CandidateId,
  world: Schema.String,
  /** The project's deploy target it went to, and who hosts it. */
  target: DeployTargetName,
  provider: DeployProvider,
  /** The candidate's own version. */
  url: Schema.String,
  /** The change's stable address, when the candidate is that one change's. */
  aliasUrl: Schema.optional(Schema.String),
});
export const PreviewTornDown = Schema.TaggedStruct("PreviewTornDown", {
  deploymentId: DeploymentId,
});
export const DeploymentPromoted = Schema.TaggedStruct("DeploymentPromoted", {
  deploymentId: DeploymentId,
  trunkSha: CommitSha,
  target: DeployTargetName,
  provider: DeployProvider,
  stage: Schema.String,
});
export const DeploymentRolledBack = Schema.TaggedStruct("DeploymentRolledBack", {
  deploymentId: DeploymentId,
  to: Schema.String,
  reason: Schema.String,
});
/**
 * Trunk advanced and Keel deployed nothing. The Deliver workflow commits it on
 * the project's stream in place of a promotion.
 */
export const DeliveryRefused = Schema.TaggedStruct("DeliveryRefused", {
  projectId: ProjectId,
  trunkSha: CommitSha,
  /** The landed candidate, when there is one. */
  candidateId: Schema.optional(CandidateId),
  /**
   * `commit-differs`: trunk's new commit is not the candidate's own commit
   * that was previewed (a batch composed new commits, or a landing by
   * commutation), so the version Keel previewed is not trunk's tree and is
   * not promoted. `no-preview`: no preview of the landed candidate was made
   * (no connected account for the deploy spec's target, or the preview did
   * not pass). `promote-failed`: Cloudflare did not take the promote.
   */
  reason: Schema.Literals(["commit-differs", "no-preview", "promote-failed"]),
  /** Why, in words: for `promote-failed`, what Cloudflare answered. The token is never in it. */
  detail: Schema.String,
});

export const DeliveryEvent = Schema.Union([
  CredentialStored,
  CredentialRemoved,
  DeployTargetSet,
  DeployTargetCleared,
  PreviewDeployed,
  PreviewTornDown,
  DeploymentPromoted,
  DeploymentRolledBack,
  DeliveryRefused,
]);
export type DeliveryEvent = typeof DeliveryEvent.Type;
