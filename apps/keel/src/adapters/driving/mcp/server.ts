import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { Admitted } from "@keeltown/core/application/identity";
import type { ToolDeps } from "../../../generated/mcp/mcp-runtime.gen.ts";
import { registerTools } from "../../../generated/mcp/mcp.gen.ts";
import { type Caller, presentedToken } from "../http/caller.ts";
import { gate, type GateDeps } from "../http/gate.ts";
import type { Handlers } from "../http/handlers.ts";

/** What the gate admitted travels to the tool handlers inside AuthInfo, in the same isolate. */
const ADMITTED = "admitted";

/** Whether a value is what the gate admitted: AuthInfo carries it as `unknown`. */
const isAdmitted = (value: unknown): value is Admitted =>
  typeof value === "object" && value !== null && "principal" in value;

function admittedOf(auth: AuthInfo | undefined): Admitted {
  const admitted: unknown = auth?.extra?.[ADMITTED];
  return isAdmitted(admitted) ? admitted : { principal: { _tag: "Anonymous" } };
}

function toolDeps(admitted: Admitted): ToolDeps<Caller> {
  return {
    // Every tool is listed: the one policy decides each call, as it does over REST.
    permits: () => true,
    context: (context) => ({
      requestId: crypto.randomUUID(),
      principal: admitted.principal,
      ...(admitted.token === undefined ? {} : { token: admitted.token }),
      ...(admitted.signedIn === undefined ? {} : { signedIn: admitted.signedIn }),
      signal: context.http?.req?.signal ?? new AbortController().signal,
    }),
    noContext: () => ({ content: [{ type: "text", text: "Not authenticated." }], isError: true }),
  };
}

/** A 401 in OAuth's shape, as the MCP SDK answers one, with the gate's challenge for this door. */
function unauthenticated(challenge: string, detail: string): Response {
  const refused = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, detail));
  refused.headers.set("www-authenticate", challenge);
  return refused;
}

/**
 * The stateless MCP endpoint: one McpServer per request, built for that
 * request's admitted caller, dispatching into the same handler object as REST.
 * It passes the same gate as REST, at its own door: a bearer (an agent's token
 * or a user's session) or an agent's key-bound token under the `DPoP` scheme
 * with its proof, and never the session cookie. A request with no good
 * credential is answered 401 in OAuth's shape, with the gate's challenge
 * naming this door's metadata.
 */
export function makeMcpEndpoint(
  handlers: Handlers,
  deps: GateDeps,
  allowedHosts: readonly string[],
) {
  const mcp = createMcpHandler((context) => {
    const server = new McpServer({ name: "keel", version: "0.0.0" });
    registerTools(server, () => handlers, toolDeps(admittedOf(context.authInfo)));
    return server;
  });
  return async (request: Request): Promise<Response> => {
    const badHost = hostHeaderValidationResponse(request, [...allowedHosts]);
    if (badHost !== undefined) return badHost;
    const badOrigin = originValidationResponse(request, [...allowedHosts]);
    if (badOrigin !== undefined) return badOrigin;
    const presented = presentedToken(request.headers.get("authorization") ?? "");
    if (presented === null)
      return unauthenticated(deps.challenge("mcp"), "A bearer token is required");
    const gated = await gate(request, crypto.randomUUID(), deps, { cookies: false, door: "mcp" });
    if (gated instanceof Response)
      return unauthenticated(
        gated.headers.get("www-authenticate") ?? deps.challenge("mcp"),
        "The token is not admitted",
      );
    const { principal } = gated.admitted;
    const authInfo: AuthInfo = {
      token: presented.token,
      clientId:
        principal._tag === "Agent"
          ? principal.agentId
          : principal._tag === "User"
            ? principal.userId
            : principal._tag,
      scopes: principal._tag === "Agent" ? [...principal.scopes] : [],
      // Keel's own expiry is enforced by the gate; the SDK requires a value.
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      extra: { [ADMITTED]: gated.admitted },
    };
    return mcp.fetch(request, { authInfo });
  };
}
