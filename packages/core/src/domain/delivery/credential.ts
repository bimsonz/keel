import { Schema } from "effect";
import { CredentialId, NamespaceId, UserId } from "../kernel/index.ts";
import { DeployProvider } from "./deployment.ts";

/** What an owner calls a credential: shown in its place, since the secret never is. */
export const CredentialLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^\S(?:.*\S)?$/),
);
export type CredentialLabel = typeof CredentialLabel.Type;

/**
 * A credential as anyone may read it: who stored it, when and for which
 * provider. The secret is write-only: it is sealed when stored and
 * opened only by the Deployer, so no record, event or response carries it.
 */
export const CredentialMeta = Schema.Struct({
  id: CredentialId,
  namespaceId: NamespaceId,
  label: CredentialLabel,
  provider: DeployProvider,
  createdAt: Schema.Number,
  createdBy: UserId,
});
export type CredentialMeta = typeof CredentialMeta.Type;
