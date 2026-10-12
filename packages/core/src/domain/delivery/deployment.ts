import { Schema } from "effect";
import { CredentialId, DeploymentId } from "../kernel/index.ts";

/**
 * Who hosts a deploy target. Cloudflare is the only one so far, so this is one
 * literal; another provider makes it a union and brings its own record (ADR 0008).
 */
export const DeployProvider = Schema.Literal("cloudflare");
export type DeployProvider = typeof DeployProvider.Type;

/** A deploy target's name, unique in its project: what a repo's `.keel/deploy` gives. A handle's shape. */
export const DeployTargetName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:-?[a-z0-9]){0,38}$/),
).pipe(Schema.brand("DeployTargetName"));
export type DeployTargetName = typeof DeployTargetName.Type;

/** A Cloudflare account's id: 32 lower-case hex characters. */
export const CloudflareAccountId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));

/**
 * A place a project deploys to: a provider, the account there and a
 * reference to the credential that reaches it, set by an owner of the
 * project's org. It names the credential and never holds it: a `CredentialId`
 * is minted when a secret is stored, so nothing a person types fits the field.
 */
export const DeployTarget = Schema.Struct({
  name: DeployTargetName,
  provider: DeployProvider,
  accountId: CloudflareAccountId,
  credential: CredentialId,
});
export type DeployTarget = typeof DeployTarget.Type;

export const DeploymentState = Schema.Literals([
  "previewing",
  "live",
  "torn-down",
  "promoting",
  "promoted",
  "rolled-back",
]);
export type DeploymentState = typeof DeploymentState.Type;

export const Deployment = Schema.Struct({
  id: DeploymentId,
  /** The project's deploy target it went to, by name. */
  target: DeployTargetName,
  world: Schema.String,
  url: Schema.optional(Schema.String),
  state: DeploymentState,
});
export type Deployment = typeof Deployment.Type;

/** What every Deployer operation returns: what happened, as evidence. */
export const DeployEvidence = Schema.Struct({
  deploymentId: DeploymentId,
  operation: Schema.Literals(["plan", "preview", "verify", "promote", "rollback", "teardown"]),
  ok: Schema.Boolean,
  detail: Schema.String,
  ref: Schema.optional(Schema.String),
});
export type DeployEvidence = typeof DeployEvidence.Type;
