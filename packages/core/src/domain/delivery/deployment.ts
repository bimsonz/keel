import { Schema } from "effect";
import { DeploymentId } from "../kernel/index.ts";

/** Where a deployment goes. Cloudflare targets are first-class; others are plugins (ADR 0008). */
export const DeployTarget = Schema.Literals([
  "isolate-preview",
  "workers-previews",
  "versions",
  "workers-for-platforms",
  "r2",
  "container-image",
  "iac",
  "external",
]);
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
  target: DeployTarget,
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
