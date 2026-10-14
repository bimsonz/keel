// An instance's OAuth client on Cloudflare, at deploy. Connecting a Cloudflare account is for the instance's
// users, so they can deploy their own projects through Keel; it never touches the instance's own deploys. The
// client is optional configuration: with Terraform's client the Worker gets its id and its secret's binding;
// without one it deploys with neither, and Connect answers that the instance has none.

/** The var keel reads the client's id from, and the binding it reads the client's secret through. */
export const CLIENT_ID_VAR = "CF_OAUTH_CLIENT_ID";
export const CLIENT_SECRET_BINDING = "CF_OAUTH_CLIENT_SECRET";

/** The Terraform output that holds the client's id once Terraform has registered it. */
export const CLIENT_ID_OUTPUT = "cloudflare_oauth_client_id";

/** What a deploy does with a Worker's OAuth client. */
export type OAuthClientAtDeploy =
  /** The Worker reads no OAuth client. */
  | { readonly kind: "none" }
  /** Terraform has registered the client: the var is set to its id, and the secret stays bound. */
  | { readonly kind: "registered"; readonly clientId: string }
  /**
   * Terraform has no client yet: the Worker deploys without the secret's binding, the entry at `dropSecretAt`
   * of its `secrets_store_secrets`, and with its id empty, and the deploy says so.
   */
  | {
      readonly kind: "unregistered";
      readonly dropSecretAt: number | undefined;
      readonly said: string;
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a deploy does with the OAuth client a Worker's config reads, given Terraform's outputs. */
export function oauthClientAtDeploy(
  config: unknown,
  outputs: ReadonlyMap<string, string>,
): OAuthClientAtDeploy {
  const vars = isObject(config) ? config["vars"] : undefined;
  if (!isObject(vars) || !(CLIENT_ID_VAR in vars)) return { kind: "none" };
  const clientId = outputs.get(CLIENT_ID_OUTPUT);
  if (clientId !== undefined && clientId !== "") return { kind: "registered", clientId };
  const secrets = isObject(config) ? config["secrets_store_secrets"] : undefined;
  const index = Array.isArray(secrets)
    ? secrets.findIndex((secret) => isObject(secret) && secret["binding"] === CLIENT_SECRET_BINDING)
    : -1;
  return {
    kind: "unregistered",
    dropSecretAt: index < 0 ? undefined : index,
    said: `Terraform has no OAuth client on Cloudflare yet (no output ${CLIENT_ID_OUTPUT}), so this deploy binds none: Connect answers that the instance has no client until one is registered and deployed.`,
  };
}
