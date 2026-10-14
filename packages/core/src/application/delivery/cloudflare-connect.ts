import { Effect } from "effect";
import {
  type CloudflareConnectFailed,
  type ConnectAccountsRefused,
  type ConnectStateRefused,
  type DeployTargetName,
  type DeployTargetRefused,
  type DeployTargetUnreachable,
  deployTokenName,
  oneAccount,
} from "../../domain/delivery/index.ts";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import type { NamespaceId, ProjectId, UserId } from "../../domain/kernel/index.ts";
import {
  CloudflareOAuth,
  CredentialStore,
  type DeployTargetCheck,
  DeployTargets,
  type HeldDeployTarget,
} from "../ports/index.ts";
import { putDeployTarget } from "./deploy-targets.ts";

/** An owner beginning a Connect of a project's deploy target to a Cloudflare account. */
export interface BeginCloudflareConnect {
  readonly projectId: ProjectId;
  readonly target: DeployTargetName;
  readonly by: UserId;
}

/**
 * Begins a Connect: a fresh nonce and PKCE verifier, held by the project's
 * object under the owner, and the consent screen to send them to. Beginning
 * again replaces the one before.
 */
export const beginCloudflareConnect: (
  input: BeginCloudflareConnect,
) => Effect.Effect<
  string,
  CloudflareConnectFailed | ProjectNotFound,
  CloudflareOAuth | DeployTargets
> = Effect.fn("delivery/beginCloudflareConnect")(function* (input: BeginCloudflareConnect) {
  const { projectId, target, by } = input;
  const start = yield* CloudflareOAuth.use((oauth) => oauth.begin(projectId));
  yield* DeployTargets.use((targets) =>
    targets.holdConnect({ projectId, by, target, nonce: start.nonce, verifier: start.verifier }),
  );
  return start.url;
});

/** An owner back from Cloudflare's consent screen with a code, on the project their state named. */
export interface CompleteCloudflareConnect {
  readonly projectId: ProjectId;
  readonly namespaceId: NamespaceId;
  /** The namespace's handle and the project's name, which the minted token is named by. */
  readonly handle: string;
  readonly project: string;
  readonly by: UserId;
  readonly nonce: string;
  readonly code: string;
  readonly requestId: string;
}

export type CloudflareConnectError =
  | ProjectNotFound
  | ConnectStateRefused
  | CloudflareConnectFailed
  | ConnectAccountsRefused
  | DeployTargetRefused
  | DeployTargetUnreachable
  | IdempotencyConflict;

/**
 * Finishes a Connect. The owner's pending Connect is taken first, so a state
 * is tried once; the code is exchanged with its verifier; the consent must
 * have granted exactly one account; on it Keel mints an API token of its own,
 * named for the project, that may only edit the account's Workers. That token
 * is sealed as a credential of the project's namespace and the target is set
 * with it, which asks the account first, as any target's credential is asked.
 * The consent's access token is used for the reads and the mint and dropped:
 * it is in no store, event or answer.
 */
export const completeCloudflareConnect: (
  input: CompleteCloudflareConnect,
) => Effect.Effect<
  HeldDeployTarget,
  CloudflareConnectError,
  CloudflareOAuth | CredentialStore | DeployTargetCheck | DeployTargets
> = Effect.fn("delivery/completeCloudflareConnect")(function* (input: CompleteCloudflareConnect) {
  const { projectId, namespaceId, by, requestId } = input;
  const pending = yield* DeployTargets.use((targets) =>
    targets.takeConnect({ projectId, by, nonce: input.nonce }),
  );
  const oauth = yield* CloudflareOAuth;
  const access = yield* oauth.exchange(input.code, pending.verifier);
  const account = yield* Effect.fromResult(oneAccount(yield* oauth.accounts(access)));
  const name = deployTokenName(input.handle, input.project);
  const secret = yield* oauth.mint(access, account.id, name);
  const credential = yield* CredentialStore.use((store) =>
    store.put(namespaceId, { label: name, provider: "cloudflare", secret, by }),
  );
  return yield* putDeployTarget({
    projectId,
    namespaceId,
    target: {
      name: pending.target,
      provider: "cloudflare",
      accountId: account.id,
      credential: credential.id,
    },
    by,
    requestId,
  });
});
