import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { AGENT_SCOPES, CLOSED_PATHS } from "./agents.ts";
import { AUTH_BASE_PATH, type KeelAuth } from "./auth.ts";
import { KEY_ALGORITHMS } from "./key-proofs.ts";

/**
 * What an arriving agent reads to find its way in: the two discovery documents
 * OAuth clients look for at an origin's root. Both are the provider's own. Keel
 * re-serves them because Better Auth answers under `/v1/auth`, and takes out of
 * the first every route it has closed, so the document names only what answers.
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
 * The authorization server's document (RFC 8414): the provider's own, with its
 * issuer, token endpoint, key location and what a token request may be signed
 * with. Two things are Keel's: a field naming a route Keel does not serve is
 * left out, and `registration_endpoint`, which the provider always points at
 * its own closed route, names where an agent signs up with its key.
 */
export async function authorizationServerDocument(
  auth: KeelAuth,
  where: { readonly origin: string; readonly signUpUrl: string },
  request: Request,
): Promise<Response> {
  const answer = await oauthProviderAuthServerMetadata({ api: metadataApi(auth.api) })(request);
  const provided: unknown = await answer.json();
  const closed = new Set<string>(
    CLOSED_PATHS.map((path) => `${where.origin}${AUTH_BASE_PATH}${path}`),
  );
  const served = Object.fromEntries(
    Object.entries(Object(provided)).filter(
      ([, value]) => !(typeof value === "string" && closed.has(value)),
    ),
  );
  return Response.json(
    { ...served, registration_endpoint: where.signUpUrl },
    { status: answer.status, headers: CACHED },
  );
}

/** The documents change only with a deploy; a client may keep one for five minutes. */
const CACHED = { "cache-control": "public, max-age=300" };

/**
 * A protected resource's document (RFC 9728): which resource this is, the
 * server that issues its tokens, and how a token is presented to it.
 */
export async function protectedResourceDocument(
  auth: KeelAuth,
  origin: string,
  resource: string,
): Promise<Response> {
  const provided = await oauthProviderResourceClient(auth)
    .getActions()
    .getProtectedResourceMetadata({
      resource,
      authorization_servers: [`${origin}${AUTH_BASE_PATH}`],
      scopes_supported: [...AGENT_SCOPES],
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: [...KEY_ALGORITHMS],
    });
  return Response.json(provided, { headers: CACHED });
}
