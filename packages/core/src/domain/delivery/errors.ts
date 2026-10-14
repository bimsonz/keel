import { Schema } from "effect";
import { CredentialId } from "../kernel/index.ts";
import { DeployTargetName } from "./deployment.ts";

/**
 * A provider call that did not do what Keel asked. `refused` is the provider
 * refusing what was sent (a Worker that throws as it starts, one too large):
 * the change's to fix. The rest are not the change's: the token was refused,
 * the Worker's version addresses are off (the owner's to turn on), or the
 * provider could not be reached or answered nothing Keel could read.
 */
export class DeploymentFailed extends Schema.TaggedError<DeploymentFailed>()("DeploymentFailed", {
  operation: Schema.Literals(["preview", "promote", "delete-version"]),
  reason: Schema.Literals(["refused", "token-refused", "previews-off", "unreachable"]),
  detail: Schema.String,
  code: Schema.optional(Schema.Number),
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
