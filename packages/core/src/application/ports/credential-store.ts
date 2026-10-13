import { Context, type Effect, type Redacted } from "effect";
import type {
  CredentialLabel,
  CredentialMeta,
  CredentialMissing,
  DeployProvider,
} from "../../domain/delivery/index.ts";
import type { CredentialId, NamespaceId, UserId } from "../../domain/kernel/index.ts";

export interface StoreCredential {
  readonly label: CredentialLabel;
  readonly provider: DeployProvider;
  readonly secret: Redacted.Redacted;
  readonly by: UserId;
}

/**
 * An org's credentials, write-only. `put` seals the secret with a
 * data key of its own, wrapped by a key held in Secrets Store, bound to the
 * org and the credential's id, and mints the id. Only `reveal` opens one, and
 * only the Deployer calls it, to put the secret in a request header: no route,
 * event, log or step output ever carries it.
 */
export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    readonly put: (
      namespaceId: NamespaceId,
      credential: StoreCredential,
    ) => Effect.Effect<CredentialMeta>;
    readonly list: (namespaceId: NamespaceId) => Effect.Effect<readonly CredentialMeta[]>;
    /** Whether the org holds the credential: the `credentialInOrg` fact `setDeployTarget` takes. */
    readonly has: (namespaceId: NamespaceId, id: CredentialId) => Effect.Effect<boolean>;
    readonly reveal: (
      namespaceId: NamespaceId,
      id: CredentialId,
    ) => Effect.Effect<Redacted.Redacted, CredentialMissing>;
    readonly remove: (
      namespaceId: NamespaceId,
      id: CredentialId,
      by: UserId,
    ) => Effect.Effect<void, CredentialMissing>;
  }
>()("keel/CredentialStore") {}
