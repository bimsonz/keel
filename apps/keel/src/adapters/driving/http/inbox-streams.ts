import { authorize, type InboxPage } from "@keeltown/core/domain/identity";
import type { AgentId, RunId } from "@keeltown/core/kernel";
import { Result } from "effect";
import type { Hono } from "hono";
import type { AppEnv, RouteDeps } from "../../../generated/http/runtime.gen.ts";
import { isInboxCursor, sseEvent } from "../notices.ts";
import type { Caller } from "./caller.ts";
import { agentsOnly, refusalResult } from "./authorize-handlers.ts";
import { problemResponse } from "./problems.ts";

/**
 * What the agent's live inbox routes need from composition. They are not in
 * the spec yet (http-zod caps `@typespec/streams`), so they sit beside the
 * generated routes and use the same auth gate.
 */
export interface InboxStreams {
  /** Notices after `cursor` for `run`, waiting up to `waitSeconds` for one: the Inbox port. */
  readonly read: (
    agentId: AgentId,
    cursor: string | undefined,
    waitSeconds: number,
    signal: AbortSignal,
    run: RunId | undefined,
  ) => Promise<InboxPage>;
  /** Hands a WebSocket upgrade to the agent's own AgentSession DO, to read as `run`. */
  readonly socket: (
    agentId: AgentId,
    request: Request,
    run: RunId | undefined,
  ) => Promise<Response>;
}

export const INBOX_STREAM_PATH = "/v1/inbox/stream";
export const INBOX_SOCKET_PATH = "/v1/inbox/socket";

/** How long one read of the SSE loop waits for a notice; an empty wait sends a keep-alive comment. */
const SSE_WAIT_SECONDS = 25;

const encoder = new TextEncoder();

/**
 * `GET /v1/inbox/stream` (SSE) and `GET /v1/inbox/socket` (WebSocket). The
 * principal and its run come only from the token: a socket is forwarded to
 * the caller's own AgentSession, never to an object the request names, and
 * reads as the run the token names, never one the request names.
 */
export function registerInboxStreams(
  app: Hono<AppEnv>,
  deps: RouteDeps<AppEnv, Caller>,
  streams: InboxStreams,
): void {
  const gate = deps.authorize([]);

  app.get(INBOX_STREAM_PATH, gate, (c) => {
    const caller = deps.context(c, "required");
    if (caller === null) return deps.noContext(c);
    const refused = inboxRefusal(caller);
    if (refused !== undefined) return refused;
    const { principal } = caller;
    if (principal._tag !== "Agent") return deps.noContext(c);
    const resumeFrom = c.req.header("last-event-id") ?? c.req.query("cursor");
    if (resumeFrom !== undefined && !isInboxCursor(resumeFrom)) return badCursor(caller);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    void (async () => {
      let cursor = resumeFrom;
      try {
        await writer.write(encoder.encode(": inbox\n\n"));
        while (!caller.signal.aborted) {
          const page = await streams.read(
            principal.agentId,
            cursor,
            SSE_WAIT_SECONDS,
            caller.signal,
            caller.token?.run?.id,
          );
          const frames =
            page.notices.length === 0 ? ": keep-alive\n\n" : page.notices.map(sseEvent).join("");
          await writer.write(encoder.encode(frames));
          cursor = page.cursor;
        }
      } catch {
        // The client went away mid-read or mid-write: nothing is lost, it resumes from Last-Event-ID.
      } finally {
        await writer.close().catch(() => undefined);
      }
    })();
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      },
    });
  });

  app.get(INBOX_SOCKET_PATH, gate, async (c) => {
    const caller = deps.context(c, "required");
    if (caller === null) return deps.noContext(c);
    const refused = inboxRefusal(caller);
    if (refused !== undefined) return refused;
    const { principal } = caller;
    if (principal._tag !== "Agent") return deps.noContext(c);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return problemResponse(400, "request.invalid", caller.requestId, {
        detail: "This route is a WebSocket: send `Upgrade: websocket`.",
      });
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !isInboxCursor(cursor)) return badCursor(caller);
    const upgraded = await streams.socket(principal.agentId, c.req.raw, caller.token?.run?.id);
    // The object's response has immutable headers, and the app's middleware adds its own afterwards.
    return new Response(upgraded.body, {
      status: upgraded.status,
      headers: upgraded.headers,
      webSocket: upgraded.webSocket,
    });
  });
}

function badCursor(caller: Caller): Response {
  return problemResponse(400, "request.invalid", caller.requestId, {
    detail: "The cursor is not one Keel gave out: use a notice's `cursor` or an inbox page's.",
  });
}

/**
 * The inbox is the caller's own (`inbox`, decided on Self like `GET /v1/inbox`),
 * and only an agent has one: the policy refuses anyone else first.
 */
function inboxRefusal(caller: Caller): Response | undefined {
  const decided = authorize(caller.principal, "inbox", { _tag: "Self" });
  const result = Result.isFailure(decided)
    ? refusalResult("inbox", {}, caller.requestId, decided.failure)
    : caller.principal._tag === "Agent"
      ? undefined
      : agentsOnly(caller.requestId);
  return (
    result &&
    new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/problem+json" },
    })
  );
}
