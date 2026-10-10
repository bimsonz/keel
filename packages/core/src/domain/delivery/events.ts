import { Schema } from "effect";
import { CommitSha, DeploymentId } from "../kernel/index.ts";
import { DeployTarget } from "./deployment.ts";

export const PreviewDeployed = Schema.TaggedStruct("PreviewDeployed", {
  deploymentId: DeploymentId,
  world: Schema.String,
  adapter: DeployTarget,
  url: Schema.String,
});
export const PreviewTornDown = Schema.TaggedStruct("PreviewTornDown", { deploymentId: DeploymentId });
export const DeploymentPromoted = Schema.TaggedStruct("DeploymentPromoted", {
  deploymentId: DeploymentId,
  trunkSha: CommitSha,
  adapter: DeployTarget,
  stage: Schema.String,
});
export const DeploymentRolledBack = Schema.TaggedStruct("DeploymentRolledBack", { deploymentId: DeploymentId, to: Schema.String, reason: Schema.String });

export const DeliveryEvent = Schema.Union([PreviewDeployed, PreviewTornDown, DeploymentPromoted, DeploymentRolledBack]);
export type DeliveryEvent = typeof DeliveryEvent.Type;
