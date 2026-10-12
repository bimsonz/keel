import { Schema } from "effect";
import { DeploymentId } from "../kernel/index.ts";
import { DeployTargetName } from "./deployment.ts";

export class DeploymentFailed extends Schema.TaggedError<DeploymentFailed>()("DeploymentFailed", {
  deploymentId: DeploymentId,
  operation: Schema.String,
  reason: Schema.String,
}) {}

export class SecretMissing extends Schema.TaggedError<SecretMissing>()("SecretMissing", {
  name: Schema.String,
}) {}

/**
 * A deploy target that was not set, cleared or found: its credential is not in
 * the project's org, the project already has all the targets it may, or no
 * target of that name is set.
 */
export class DeployTargetRefused extends Schema.TaggedError<DeployTargetRefused>()(
  "DeployTargetRefused",
  {
    name: DeployTargetName,
    reason: Schema.Literals(["credential-not-in-org", "too-many-targets", "not-set"]),
  },
) {}
