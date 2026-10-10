import { Schema } from "effect";
import { DeploymentId } from "../kernel/index.ts";

export class DeploymentFailed extends Schema.TaggedError<DeploymentFailed>()("DeploymentFailed", {
  deploymentId: DeploymentId,
  operation: Schema.String,
  reason: Schema.String,
}) {}

export class SecretMissing extends Schema.TaggedError<SecretMissing>()("SecretMissing", { name: Schema.String }) {}
