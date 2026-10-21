import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { AGENT_SCOPES, agentResources } from "./agents.ts";
import { APP_SCOPES } from "./apps.ts";
import { AUTH_BASE_PATH, type KeelAuth } from "./auth.ts";
import { KEY_ALGORITHMS } from "./key-proofs.ts";

/**
 * What an arriving agent reads to find its way in: the two discovery documents
 * OAuth clients look for at an origin's root. Keel serves them itself because
 * Better Auth answers under `/v1/auth`, and because the provider's own first
 * document says more than Keel takes.
 */

interface MetadataApi {
  readonly getOAuthServerConfig: (...args: never[]) => unknown;
}

/** The provider's metadata route. Its plugin is handed to Better Auth untyped (see `agentTokens`), so it is found here. */
function metadataApi(api: object): MetadataApi {
  const route: unknown = Reflect.get(api, "getOAuthServerConfig");
  if (typeof route !== "function") throw new Error("the OAuth provider is not mounted");
  return { getOAuthServerConfig: (...args) => Reflect.apply(route, api, args) };
}

/**
 * What the provider's document says that is true of Keel's server as it
 * stands: where it is, where a person signs in through an app, where a token
 * is asked for, where its keys are, its scopes, its grants (an agent's client
 * credentials, an app's code and refreshes), the one response type an app
 * asks for (`code`) and how it proves the code is its own (`S256`).
 */
const PROVIDED = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "jwks_uri",
  "scopes_supported",
  "response_types_supported",
  "grant_types_supported",
  "code_challenge_methods_supported",
] as const;

/**
 * The authorization server's document (RFC 8414). It names what Keel takes and
 * nothing more. The provider's own lists every method and algorithm the
 * library knows, for endpoints Keel does not serve and clients it has none of,
 * so each field is chosen here by name and no default of the library's reaches
 * a reader. An agent authenticates with a request its key signed, and an app
 * with nothing (`none`: a public client, proving its code with PKCE); a key is
 * Ed25519 or P-256: those are the algorithms of a signed request and of a
 * proof. `registration_endpoint` names where an agent signs up with its key and
 * an app registers, and `service_documentation` the page that walks an
 * arriving agent in.
 */
export async function authorizationServerDocument(
  auth: KeelAuth,
  where: { readonly signUpUrl: string; readonly startUrl: string },
  request: Request,
): Promise<Response> {
  const answer = await oauthProviderAuthServerMetadata({ api: metadataApi(auth.api) })(request);
  const provided: object = Object(await answer.json());
  return Response.json(
    {
      ...Object.fromEntries(PROVIDED.map((name) => [name, Reflect.get(provided, name)])),
      token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
      token_endpoint_auth_signing_alg_values_supported: [...KEY_ALGORITHMS],
      dpop_signing_alg_values_supported: [...KEY_ALGORITHMS],
      registration_endpoint: where.signUpUrl,
      service_documentation: where.startUrl,
    },
    { status: answer.status, headers: CACHED },
  );
}

/** The documents change only with a deploy; a client may keep one for five minutes. */
const CACHED = { "cache-control": "public, max-age=300" };

/**
 * A protected resource's document (RFC 9728): which resource this is, the
 * server that issues its tokens, how a token is presented to it, and, as
 * `resource_documentation`, the page that walks an arriving agent in. A 401's
 * challenge names this document, so that page is two reads from any refusal.
 * Keel's MCP server is the one resource an app's token acts at, so its scopes
 * are an agent's and an app's; the API's are an agent's alone.
 */
export async function protectedResourceDocument(
  auth: KeelAuth,
  where: { readonly origin: string; readonly startUrl: string },
  resource: string,
): Promise<Response> {
  const { origin } = where;
  const apps = resource === agentResources(origin).mcp ? APP_SCOPES : [];
  const provided = await oauthProviderResourceClient(auth)
    .getActions()
    .getProtectedResourceMetadata({
      resource,
      authorization_servers: [`${origin}${AUTH_BASE_PATH}`],
      scopes_supported: [...AGENT_SCOPES, ...apps],
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: [...KEY_ALGORITHMS],
    });
  return Response.json(
    { ...provided, resource_documentation: where.startUrl },
    { headers: CACHED },
  );
}
