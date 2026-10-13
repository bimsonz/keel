import {
  type ClientDiscovery,
  type OAuthClaimExtensionInput,
  oauthProvider,
} from "@better-auth/oauth-provider";
import {
  type Agent,
  GrantableScope,
  KeyThumbprint,
  runClaims,
  type RunRefusal,
} from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { deriveDpopJkt } from "better-auth/oauth2";
import { Result, Schema } from "effect";
import { decodeProtectedHeader } from "jose";

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

/**
 * The provider's and the jwt plugin's routes Keel does not serve. An agent
 * needs the token endpoint and the published key; a person does not sign in
 * through the provider yet, so every route of that flow, every client-management
 * route and the route that turns a session into a token are closed.
 */
export const CLOSED_PATHS = [
  "/token",
  "/oauth2/authorize",
  "/oauth2/register",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/userinfo",
  "/oauth2/introspect",
  "/oauth2/revoke",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
] as const;

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

/** A refusal in OAuth's own shape (RFC 6749 §5.2), which the provider answers as it stands. */
const refuse = (error: string, description: string) =>
  new APIError("BAD_REQUEST", { error, error_description: description });

function refusal(failure: RunRefusal): APIError {
  switch (failure._tag) {
    case "TargetRefused":
      return refuse("invalid_target", "`project` must be a project's id.");
    case "RunLabelRefused":
      return refuse(
        "invalid_request",
        "`run` must be one word of lower-case letters and digits joined by '-', '_' or '.', at most 64 characters.",
      );
    case "RunKeyRefused":
      return refuse(
        "invalid_dpop_proof",
        "A token is bound to a key made for the run, never to the key the agent signed up with.",
      );
    case "AgentNotAdmitted":
      return refuse("invalid_client", "This agent may not act.");
    default: {
      const unmapped: never = failure;
      return unmapped;
    }
  }
}

/** One of the token request's form fields: absent, or its text. Anything else is no value at all. */
function field(body: unknown, name: string): string | undefined {
  if (typeof body !== "object" || body === null || !(name in body)) return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(body, name)?.value;
  return typeof value === "string" ? value : "";
}

const asThumbprint = Schema.decodeUnknownOption(KeyThumbprint);

/** The key that made the request's proof. The provider has verified the proof before it asks for claims. */
async function proofKey(proof: string): Promise<KeyThumbprint> {
  const unproven = refuse("invalid_dpop_proof", "The proof names no key.");
  let jwk: ReturnType<typeof decodeProtectedHeader>["jwk"];
  try {
    ({ jwk } = decodeProtectedHeader(proof));
  } catch {
    throw unproven;
  }
  if (jwk === undefined) throw unproven;
  const thumbprint = asThumbprint(await deriveDpopJkt(jwk));
  if (thumbprint._tag === "None") throw unproven;
  return thumbprint.value;
}

/**
 * What Keel adds to an agent's token: the project and the run the request
 * names, the agent's epoch and its handle. A request the rule refuses gets no
 * token.
 */
export async function agentClaims(
  agents: AgentAccess,
  input: OAuthClaimExtensionInput,
): Promise<Record<string, unknown>> {
  const { clientId } = input.client;
  if (input.client.clientDiscoveryId !== AGENT_DISCOVERY || !isAgentId(clientId)) return {};
  const agent = await agents.find(clientId);
  if (agent === undefined) throw refuse("invalid_client", "This agent is not known.");
  const body: unknown = input.ctx.body;
  const proof = input.ctx.headers?.get("dpop") ?? undefined;
  const decided = runClaims(agent, {
    project: field(body, "project"),
    run: field(body, "run"),
    runKey: proof === undefined ? undefined : await proofKey(proof),
  });
  if (Result.isFailure(decided)) throw refusal(decided.failure);
  const { epoch, handle, prj, run } = decided.success;
  return {
    epoch,
    ...(handle === undefined ? {} : { handle }),
    ...(prj === undefined ? {} : { prj }),
    ...(run === undefined ? {} : { run: run.id }),
    ...(run?.label === undefined ? {} : { run_label: run.label }),
  };
}

/**
 * Deletes the one-time ids whose window has passed: the id of each signed token
 * request, which the provider keeps and never deletes, and the id of each DPoP
 * proof, which Better Auth prunes only when a person signs in. An id is held so
 * that its request or proof is good once; past its expiry the request or proof
 * is refused for its age, so the row guards nothing. It runs on the token
 * request's own path, which is what writes them: no schedule.
 */
export async function forgetSpentIds(db: D1Database, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  await db.batch([
    db.prepare(`DELETE FROM "oauthClientAssertion" WHERE "expiresAt" < ?`).bind(at),
    db
      .prepare(
        `DELETE FROM "verification" WHERE "identifier" LIKE 'dpop-proof:%' AND "expiresAt" < ?`,
      )
      .bind(at),
  ]);
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
  // Better Auth is made for one request, so the agent is read once for all of it: the provider
  // resolves a client more than once, and the claims are decided on the same record.
  const read = new Map<AgentId, Promise<Agent | undefined>>();
  const agents: AgentAccess = {
    find: (agentId) => {
      const known = read.get(agentId) ?? config.agents.find(agentId);
      read.set(agentId, known);
      return known;
    },
  };
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
    extensions: [
      {
        clientDiscovery: agentDiscovery(agents),
        claims: { accessToken: (input) => agentClaims(agents, input) },
      },
    ],
    // Keel serves the discovery documents at its origin's root itself.
    silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
  }) as BetterAuthPlugin;
}
