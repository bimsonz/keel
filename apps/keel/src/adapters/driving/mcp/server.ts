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
import { registerTools, TOOL_NAMES } from "../../../generated/mcp/mcp.gen.ts";
import { type Caller, presentedToken } from "../http/caller.ts";
import { gate, type GateDeps } from "../http/gate.ts";
import type { Handlers } from "../http/handlers.ts";
import { serveListen, type Watches } from "./listen.ts";
import { registerResources } from "./resources.ts";

/** What the server tells every agent that connects, whatever harness it runs in. */
const INSTRUCTIONS =
  "Start with `whoami` and act on its `next`: it says what you still need (a sponsor, an invitation) and which tool does it. " +
  "Keel coordinates the changes agents make to a project and remembers what was decided about its code. " +
  "Before you change a file, ask `why` about it (its `path`, or a `subject`): Keel answers with each active decision anchored there, " +
  "the ruling, the premise it upheld and the guard holding it, so your change does not undo what was decided. " +
  "Declare your intent before you write code, and read `inbox` for what moved under what you rely on.";

/** What a person signed in as themselves is told: the work tools are an agent's, the questions and rulings theirs. */
export const PERSON_INSTRUCTIONS =
  "You are signed in as a person, and what you do here is done as them. " +
  "`Operator_listEscalations` lists the questions Keel has put to them, each naming what it is about and the options it offers. " +
  "Read a change a question is about with `diff`, and an issue with `issues` and `issue`. " +
  "Rule only when they have told you their ruling: `Operator_giveRuling` names one of the question's options and records the decision as theirs.";

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
 * How often a held tool call with a progress token says again that it is
 * waiting: well inside a client's idle limit, since a client drops a call that
 * has sent nothing for a while (one does at 325 seconds).
 */
export const PROGRESS_EVERY_SECONDS = 30;

/**
 * The three reads that wait, as one tool call holds them. Given a progress
 * token, the call sends a progress notice at once, so its answer is a stream
 * from the first byte, and another every `PROGRESS_EVERY_SECONDS` until it
 * answers, so it may wait as long as the operation allows; given none, it
 * waits `UNTOLD_WAIT_SECONDS` at most.
 */
export function held(handlers: Handlers, context: ServerContext): Handlers {
  const { _meta: meta } = context.mcpReq;
  const token = meta?.progressToken;
  const told = (progress: number) =>
    context.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken: token, progress, message: "Waiting for something to arrive" },
    });
  const waiting = async <I extends { readonly wait?: number }, A>(
    input: I,
    read: (input: I) => A | Promise<A>,
  ): Promise<A> => {
    if (input.wait === undefined || input.wait === 0) return read(input);
    if (token === undefined)
      return read(
        input.wait > UNTOLD_WAIT_SECONDS ? { ...input, wait: UNTOLD_WAIT_SECONDS } : input,
      );
    await told(0);
    let progress = 0;
    let beat: ReturnType<typeof setTimeout> | undefined;
    // Each notice arms the next one's deadline, inside the client's idle limit: nothing is polled.
    const arm = () => {
      beat = setTimeout(() => {
        progress += 1;
        // A stream the client has let go refuses the notice; the read ends with it anyway.
        told(progress).catch(() => undefined);
        arm();
      }, PROGRESS_EVERY_SECONDS * 1000);
    };
    arm();
    try {
      return await read(input);
    } finally {
      clearTimeout(beat);
    }
  };
  return {
    ...handlers,
    inbox: async (caller, input) => waiting(input, (asked) => handlers.inbox(caller, asked)),
    // A model reads the log a line per event unless it asks for the whole: it holds every agent's events.
    Inbox_listEvents: async (caller, input) =>
      waiting({ ...input, view: input.view ?? "lines" }, (asked) =>
        handlers.Inbox_listEvents(caller, asked),
      ),
    status: async (caller, input) => waiting(input, (asked) => handlers.status(caller, asked)),
  };
}

const TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The next actions an agent here can take: one that names an operation is kept only when that operation is a tool. */
export const toolActions = (actions: unknown): unknown =>
  Array.isArray(actions)
    ? actions.filter(
        (action) =>
          !isRecord(action) ||
          typeof action["operationId"] !== "string" ||
          TOOLS.has(action["operationId"]),
      )
    : actions;

/** Each notice of a list, with only the next actions an agent here can take. */
const toolNotices = (notices: unknown): unknown =>
  Array.isArray(notices)
    ? notices.map((notice) =>
        isRecord(notice) && "nextActions" in notice
          ? { ...notice, nextActions: toolActions(notice["nextActions"]) }
          : notice,
      )
    : notices;

/**
 * An answer as this door gives it: every next action it names (an envelope's
 * `next`, a refusal's `nextActions`, and those of each notice it carries, its
 * inbox page's included) is one the agent can call here. REST names every
 * operation; an MCP client has only the tools, and a next action it cannot
 * take leaves it stuck.
 */
export function toolsOnly(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const told: Record<string, unknown> = { ...body };
  if ("next" in told) told["next"] = toolActions(told["next"]);
  if ("nextActions" in told) told["nextActions"] = toolActions(told["nextActions"]);
  if ("notices" in told) told["notices"] = toolNotices(told["notices"]);
  if (isRecord(told["result"]) && "notices" in told["result"])
    told["result"] = { ...told["result"], notices: toolNotices(told["result"]["notices"]) };
  return told;
}

/** The handlers as the MCP door calls them: each tool's answer names only tools as next actions. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- the wrapper dispatches by tool name over the
   handlers, each typed where it is declared: here each is one function answering `{ status, body }`,
   and only the body's next actions are narrowed, so every answer keeps its own arm's shape. */
export function onlyTools(handlers: Handlers): Handlers {
  const told: Record<string, unknown> = { ...handlers };
  for (const name of TOOL_NAMES) {
    const handler = handlers[name] as (
      caller: Caller,
      input: unknown,
    ) => Promise<{ readonly status: number; readonly body: unknown }>;
    told[name] = async (caller: Caller, input: unknown) => {
      const answered = await handler(caller, input);
      return { ...answered, body: toolsOnly(answered.body) };
    };
  }
  return told as Handlers;
}
/* oxlint-enable typescript/no-unsafe-type-assertion */

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
  const told = onlyTools(handlers);
  const factory = (context: McpRequestContext) => {
    const admitted = admittedOf(context.authInfo);
    // The version the published document gives: the server's card says the same one.
    const server = new McpServer(
      { name: "keel", version: openApiDocument.info.version },
      { instructions: admitted.principal._tag === "User" ? PERSON_INSTRUCTIONS : INSTRUCTIONS },
    );
    registerTools(server, (call) => held(told, call), toolDeps(admitted));
    registerResources(server, told, (signal) => callerOf(admitted, signal));
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
    // The gate's own words say why, such as a token minted before its run chose a project.
    if (gated instanceof Response) {
      const said: unknown = await gated.json().catch(() => undefined);
      const detail: unknown = Reflect.get(Object(said), "detail");
      return unauthenticated(
        gated.headers.get("www-authenticate") ?? deps.challenge("mcp"),
        typeof detail === "string" ? detail : "The token is not admitted",
      );
    }
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
