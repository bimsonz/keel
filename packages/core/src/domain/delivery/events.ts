import { Schema } from "effect";
import { CommitSha, DeploymentId, ProjectId, UserId } from "../kernel/index.ts";
import { DeployProvider, DeployTarget, DeployTargetName } from "./deployment.ts";

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
  DeployTargetSet,
  DeployTargetCleared,
  PreviewDeployed,
  PreviewTornDown,
  DeploymentPromoted,
  DeploymentRolledBack,
]);
export type DeliveryEvent = typeof DeliveryEvent.Type;
