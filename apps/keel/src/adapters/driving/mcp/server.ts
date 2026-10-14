import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type McpRequestContext,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { openApiDocument } from "@keeltown/contracts";
import type { Admitted } from "@keeltown/core/application/identity";
import type { ServerContext, ToolDeps } from "../../../generated/mcp/mcp-runtime.gen.ts";
import { registerTools } from "../../../generated/mcp/mcp.gen.ts";
import { type Caller, presentedToken } from "../http/caller.ts";
import { gate, type GateDeps } from "../http/gate.ts";
import type { Handlers } from "../http/handlers.ts";
import { serveListen, type Watches } from "./listen.ts";
import { registerResources } from "./resources.ts";

/** What the server tells every agent that connects, whatever harness it runs in. */
const INSTRUCTIONS =
  "Keel coordinates the changes agents make to a project and remembers what was decided about its code. " +
  "Before you change a file, ask `why` about it (its `path`, or a `subject`): Keel answers with each active decision anchored there, " +
  "the ruling, the premise it upheld and the guard holding it, so your change does not undo what was decided. " +
  "Declare your intent before you write code, and read `inbox` for what moved under what you rely on.";

/** What the gate admitted travels to the tool handlers inside AuthInfo, in the same isolate. */
const ADMITTED = "admitted";

/** Whether a value is what the gate admitted: AuthInfo carries it as `unknown`. */
const isAdmitted = (value: unknown): value is Admitted =>
  typeof value === "object" && value !== null && "principal" in value;

function admittedOf(auth: AuthInfo | undefined): Admitted {
  const admitted: unknown = auth?.extra?.[ADMITTED];
  return isAdmitted(admitted) ? admitted : { principal: { _tag: "Anonymous" } };
}

/** The caller the gate admitted, as every handler takes it. */
function callerOf(admitted: Admitted, signal: AbortSignal): Caller {
  return {
    requestId: crypto.randomUUID(),
    principal: admitted.principal,
    ...(admitted.token === undefined ? {} : { token: admitted.token }),
    ...(admitted.signedIn === undefined ? {} : { signedIn: admitted.signedIn }),
    signal,
  };
}

function toolDeps(admitted: Admitted): ToolDeps<Caller> {
  return {
    // Every tool is listed: the one policy decides each call, as it does over REST.
    permits: () => true,
    context: (context) =>
      callerOf(admitted, context.http?.req?.signal ?? new AbortController().signal),
    noContext: () => ({ content: [{ type: "text", text: "Not authenticated." }], isError: true }),
  };
}

/**
 * The longest a held tool call waits when its client gave no progress token.
 * Such an answer is one JSON body with no byte before it, and a client may
 * drop a call that sends nothing for a minute.
 */
export const UNTOLD_WAIT_SECONDS = 30;

/**
 * The three reads that wait, as one tool call holds them. Given a progress
 * token, the call sends one progress notice at once, so its answer is a
 * stream from the first byte and may wait as long as the operation allows;
 * given none, it waits `UNTOLD_WAIT_SECONDS` at most.
 */
export function held(handlers: Handlers, context: ServerContext): Handlers {
  const { _meta: meta } = context.mcpReq;
  const token = meta?.progressToken;
  const waiting = async <I extends { readonly wait?: number }>(input: I): Promise<I> => {
    if (input.wait === undefined || input.wait === 0) return input;
    if (token === undefined)
      return input.wait > UNTOLD_WAIT_SECONDS ? { ...input, wait: UNTOLD_WAIT_SECONDS } : input;
    await context.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken: token, progress: 0, message: "Waiting for something to arrive" },
    });
    return input;
  };
  return {
    ...handlers,
    inbox: async (caller, input) => handlers.inbox(caller, await waiting(input)),
    Inbox_listEvents: async (caller, input) =>
      handlers.Inbox_listEvents(caller, await waiting(input)),
    status: async (caller, input) => handlers.status(caller, await waiting(input)),
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
  reads: Omit<Watches, "admit">,
) {
  const factory = (context: McpRequestContext) => {
    const admitted = admittedOf(context.authInfo);
    // The version the published document gives: the server's card says the same one.
    const server = new McpServer(
      { name: "keel", version: openApiDocument.info.version },
      { instructions: INSTRUCTIONS },
    );
    registerTools(server, (call) => held(handlers, call), toolDeps(admitted));
    registerResources(server, handlers, (signal) => callerOf(admitted, signal));
    // Only the current revision listens; an earlier one has no way to watch a resource here.
    if (context.era === "modern")
      server.server.registerCapabilities({ resources: { subscribe: true } });
    return server;
  };
  const mcp = createMcpHandler(factory);
  const watches: Watches = {
    ...reads,
    admit: async (claims) => {
      const answer = await deps.admit({ _tag: "Claims", claims });
      return "admitted" in answer ? answer.admitted : null;
    },
  };
  return async (request: Request): Promise<Response> => {
    const badHost = hostHeaderValidationResponse(request, [...allowedHosts]);
    if (badHost !== undefined) return badHost;
    const badOrigin = originValidationResponse(request, [...allowedHosts]);
    if (badOrigin !== undefined) return badOrigin;
    const presented = presentedToken(request.headers.get("authorization") ?? "");
    if (presented === null)
      return unauthenticated(deps.challenge("mcp"), "A bearer token is required");
    const gated = await gate(request, crypto.randomUUID(), deps, { cookies: false, door: "mcp" });
    // A token that could not be checked is the gate's own 503: a 401 here would tell a client its good token is bad.
    if (gated instanceof Response && gated.status === 503) return gated;
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
    if (request.headers.get("mcp-method") === "subscriptions/listen") {
      // A body that is no JSON goes to the shared handler, which answers it as the protocol says.
      const asked: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      if (asked !== undefined)
        return serveListen(factory, watches, request, authInfo, gated.admitted, asked);
    }
    return mcp.fetch(request, { authInfo });
  };
}
