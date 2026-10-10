import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { ToolDeps } from "../../../generated/mcp/mcp-runtime.gen.ts";
import { registerTools } from "../../../generated/mcp/mcp.gen.ts";
import { AgentId } from "@keeltown/core/kernel";
import { Scope } from "@keeltown/core/domain/identity";
import { Option, Schema } from "effect";
import { admitsAnonymous, type Caller, type Principal, satisfies, type TokenVerifier } from "../http/caller.ts";
import type { Handlers } from "../http/handlers.ts";

const decodeAgentId = Schema.decodeUnknownOption(AgentId);
const decodeScopes = Schema.decodeUnknownOption(Schema.Array(Scope));

/** The principal travels from the bearer gate to the tool handlers inside AuthInfo, and is decoded back out. */
function principalOf(auth: AuthInfo | undefined): Principal | null {
  const agentId = decodeAgentId(auth?.extra?.["agentId"]);
  const scopes = decodeScopes(auth?.scopes ?? []);
  const epoch = auth?.extra?.["revocationEpoch"];
  if (Option.isNone(agentId) || Option.isNone(scopes) || typeof epoch !== "number") return null;
  return { agentId: agentId.value, scopes: scopes.value, revocationEpoch: epoch };
}

function toolDeps(principal: Principal | null): ToolDeps<Caller> {
  return {
    // Consulted at registration: a caller is never shown a tool it could not call.
    permits: (requirements) => admitsAnonymous(requirements) || (principal !== null && satisfies(requirements, principal)),
    context: (context) => ({ requestId: crypto.randomUUID(), principal, signal: context.http?.req?.signal ?? new AbortController().signal }),
    noContext: () => ({ content: [{ type: "text", text: "Not authenticated." }], isError: true }),
  };
}

/**
 * The stateless MCP endpoint: one McpServer per request, built for that
 * request's verified caller, dispatching into the same handler object as REST.
 */
export function makeMcpEndpoint(handlers: Handlers, verify: TokenVerifier, allowedHosts: readonly string[]) {
  const mcp = createMcpHandler((context) => {
    const server = new McpServer({ name: "keel", version: "0.0.0" });
    registerTools(server, () => handlers, toolDeps(principalOf(context.authInfo)));
    return server;
  });

  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token) {
        const verification = await verify(token);
        if ("refused" in verification) throw new OAuthError(OAuthErrorCode.InvalidToken, `The bearer token is ${verification.refused}`);
        const { principal } = verification;
        return {
          token,
          clientId: principal.agentId,
          scopes: [...principal.scopes],
          // Keel's own expiry is enforced by `verify`; the SDK requires a value.
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          extra: { agentId: principal.agentId, revocationEpoch: principal.revocationEpoch },
        };
      },
    },
  });

  return async (request: Request): Promise<Response> => {
    const badHost = hostHeaderValidationResponse(request, [...allowedHosts]);
    if (badHost !== undefined) return badHost;
    const badOrigin = originValidationResponse(request, [...allowedHosts]);
    if (badOrigin !== undefined) return badOrigin;
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return mcp.fetch(request, { authInfo: auth });
  };
}
