import { type ClientDiscovery, oauthProvider } from "@better-auth/oauth-provider";
import { type Agent, GrantableScope } from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import type { BetterAuthPlugin } from "better-auth";
import { Schema } from "effect";

/**
 * Keel as an authorization server for agents, on Better Auth's
 * OAuth provider. The provider checks an agent's signed token request (RFC
 * 7523), binds the token to the key that asks for it (DPoP, RFC 9449), signs
 * it and publishes the key. What is Keel's own is here: who an agent is, which
 * the provider asks of the agent directory each time and never keeps.
 */

/** How the provider's routes reach Keel's agents. */
export interface AgentAccess {
  /** The agent a client id names, or undefined when there is none. */
  readonly find: (agentId: AgentId) => Promise<Agent | undefined>;
}

/** Where an agent asks for a token, under Better Auth's base path. */
export const TOKEN_PATH = "/oauth2/token";

/** The name the provider records as where a client came from. */
export const AGENT_DISCOVERY = "keel-agents";

/** How long an agent's token lasts: short, because the agent asks again with its key. */
export const AGENT_TOKEN_SECONDS = 300;

/** The longest a signed token request may say it is good for. */
export const ASSERTION_SECONDS = 60;

/** The scopes an agent's token may carry. */
export const AGENT_SCOPES: readonly string[] = GrantableScope.literals;

const isAgentId = Schema.is(AgentId);
const isGrantable = Schema.is(GrantableScope);

/**
 * An agent as the provider reads a client: its keys, and the scopes its token
 * may carry. Asked on every token request, so a rotated key, a suspension and a
 * revocation all take effect at once, and nothing about an agent is copied
 * into the provider's tables. An agent a person enrolled holds no key, so it is
 * no client here.
 */
export function agentDiscovery(agents: AgentAccess): ClientDiscovery {
  return {
    id: AGENT_DISCOVERY,
    matches: isAgentId,
    resolve: async (_ctx, clientId) => {
      if (!isAgentId(clientId)) return null;
      const agent = await agents.find(clientId);
      if (agent?.keys === undefined) return null;
      return {
        clientId: agent.id,
        clientDiscoveryId: AGENT_DISCOVERY,
        name: agent.name,
        disabled: agent.state !== "active",
        tokenEndpointAuthMethod: "private_key_jwt",
        grantTypes: ["client_credentials"],
        redirectUris: [],
        jwks: JSON.stringify({ keys: agent.keys.map((key) => key.jwk) }),
        clientCredentialsScopes: agent.scopes.filter(isGrantable),
        // A token is bound when its request carries a proof; a tool that cannot sign gets a plain one.
        dpopBoundAccessTokens: false,
      };
    },
  };
}

export interface AgentTokensConfig {
  /** `https://<KEEL_HOST>`: the resource an agent's token is for. */
  readonly origin: string;
  readonly agents: AgentAccess;
}

/**
 * The provider, serving agents only: the client-credentials grant, and no
 * registration of its own.
 *
 * It is handed to Better Auth as a plain plugin. Its own type does not assign
 * under `exactOptionalPropertyTypes` (its `/oauth2/authorize` route declares
 * `items?: undefined` where Better Auth's endpoint type wants a schema), and
 * one plugin that fails to assign takes every other plugin's typed API with it.
 */
export function agentTokens(config: AgentTokensConfig): BetterAuthPlugin {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above: the plugin is one, its declared type is what does not assign
  return oauthProvider({
    // No person signs in through the provider yet: these are where it would send one.
    loginPage: `${config.origin}/login`,
    consentPage: `${config.origin}/consent`,
    grantTypes: ["client_credentials"],
    scopes: [...AGENT_SCOPES],
    resources: [config.origin],
    // The provider links a resource to a stored client row, and an agent has none: Keel has one resource.
    enforcePerClientResources: false,
    m2mAccessTokenExpiresIn: AGENT_TOKEN_SECONDS,
    assertionMaxLifetime: ASSERTION_SECONDS,
    allowDynamicClientRegistration: false,
    extensions: [{ clientDiscovery: agentDiscovery(config.agents) }],
    // Keel serves the discovery documents at its origin's root itself.
    silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
  }) as BetterAuthPlugin;
}
