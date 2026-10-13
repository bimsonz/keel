import { Schema } from "effect";
import {
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

export const PreviewDeployed = Schema.TaggedStruct("PreviewDeployed", {
  deploymentId: DeploymentId,
  world: Schema.String,
  /** The project's deploy target it went to, and who hosts it. */
  target: DeployTargetName,
  provider: DeployProvider,
  url: Schema.String,
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

export const DeliveryEvent = Schema.Union([
  CredentialStored,
  CredentialRemoved,
  DeployTargetSet,
  DeployTargetCleared,
  PreviewDeployed,
  PreviewTornDown,
  DeploymentPromoted,
  DeploymentRolledBack,
]);
export type DeliveryEvent = typeof DeliveryEvent.Type;
