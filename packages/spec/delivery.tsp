import "@typespec/http";
import "./common.tsp";
import "./events.tsp";

using Http;

namespace Keel;

/** What an owner calls a credential: shown in its place, since the secret never is. */
@minLength(1)
@maxLength(64)
@pattern("^\\S(?:.*\\S)?$")
scalar CredentialLabel extends string;

/**
 * A credential in a namespace's store as its owners read it: who stored it, when and for which provider. The
 * secret is write-only: it is sealed when stored, and no response, event or log ever carries it again.
 */
model Credential {
  id: CredentialId;
  label: CredentialLabel;
  provider: DeployProvider;
  createdAt: utcDateTime;
  createdBy: UserId;
}

model CreateCredentialRequest {
  label: CredentialLabel;
  provider: DeployProvider;

  /** The provider's API token. Stored sealed and never answered again, here or anywhere. */
  @minLength(1)
  @maxLength(4096)
  secret: string;
}

model Credentials {
  credentials: Credential[];
}

model PutDeployTargetRequest {
  provider: DeployProvider;
  accountId: CloudflareAccountId;

  /** A credential of the project's own namespace, by its id. */
  credential: CredentialId;
}

/** A project's deploy target, with the workers.dev subdomain its account answered when the target was set. */
model DeployTargetView {
  ...DeployTarget;

  /** `<subdomain>.workers.dev`: where the account serves previews. */
  workersDev?: string;
}

model DeployTargets {
  targets: DeployTargetView[];
}

/**
 * A namespace's credentials and a project's deploy targets: an owner's alone, and never an agent's, whatever it
 * governs. A credential's secret goes in once and is never read back.
 */
@tag("Delivery")
interface Delivery {
  /**
   * Store a provider's API token in a namespace, under a label. The answer names it by a minted id and never
   * carries the secret; nothing does again.
   */
  @summary("Store a credential")
  @useAuth(SessionAuth)
  @route("/namespaces/{handle}/credentials")
  @post
  createCredential(@path handle: string, @body body: CreateCredentialRequest): {
    @statusCode statusCode: 201;
    @body body: Credential;
  } | NotFound | StandardErrors;

  /** A namespace's credentials, by label and id: never a secret. */
  @summary("List a namespace's credentials")
  @useAuth(SessionAuth)
  @route("/namespaces/{handle}/credentials")
  @get
  listCredentials(@path handle: string): Credentials | NotFound | StandardErrors;

  /** Delete a credential: its secret is gone for good. A credential the namespace does not hold is not found (404). */
  @summary("Delete a credential")
  @useAuth(SessionAuth)
  @route("/namespaces/{handle}/credentials/{credentialId}")
  @delete
  deleteCredential(@path handle: string, @path credentialId: CredentialId): {
    @statusCode statusCode: 204;
  } | NotFound | StandardErrors;

  /**
   * Set a project's deploy target, new or in place of the one of that name. Its credential must be one of the
   * project's own namespace (409 `deploy_target.refused` otherwise), and must reach the account's Workers before
   * anything is set: a token the provider refuses or that does not reach the account is a 422
   * `deploy_target.unreachable`, and an account with no workers.dev subdomain a 422 `deploy_target.no_workers_dev`.
   * A project holds at most 16 targets (409 `deploy_target.refused`).
   */
  @summary("Set a project's deploy target")
  @useAuth(SessionAuth)
  @route("/projects/{projectId}/deploy-targets/{name}")
  @put
  putDeployTarget(
    @path projectId: ProjectId,
    @path name: DeployTargetName,
    @body body: PutDeployTargetRequest,
  ): DeployTargetView | NotFound | Conflict | UnprocessableContent | StandardErrors;

  /** A project's deploy targets, in name order. */
  @summary("List a project's deploy targets")
  @useAuth(SessionAuth)
  @route("/projects/{projectId}/deploy-targets")
  @get
  listDeployTargets(@path projectId: ProjectId): DeployTargets | NotFound | StandardErrors;

  /** Clear a project's deploy target. A name the project has no target by is not found (404). */
  @summary("Clear a project's deploy target")
  @useAuth(SessionAuth)
  @route("/projects/{projectId}/deploy-targets/{name}")
  @delete
  deleteDeployTarget(@path projectId: ProjectId, @path name: DeployTargetName): {
    @statusCode statusCode: 204;
  } | NotFound | StandardErrors;
}
