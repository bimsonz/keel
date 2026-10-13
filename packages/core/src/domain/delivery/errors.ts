import { Schema } from "effect";
import { CredentialId, DeploymentId } from "../kernel/index.ts";
import { DeployTargetName } from "./deployment.ts";

export class DeploymentFailed extends Schema.TaggedError<DeploymentFailed>()("DeploymentFailed", {
  deploymentId: DeploymentId,
  operation: Schema.String,
  reason: Schema.String,
}) {}

/** No credential of that id in the namespace's store: never stored there, or removed. */
export class CredentialMissing extends Schema.TaggedError<CredentialMissing>()(
  "CredentialMissing",
  { id: CredentialId },
) {}

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
