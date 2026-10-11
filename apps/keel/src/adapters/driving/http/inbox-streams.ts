import { type InboxPage, isBootstrap } from "@keeltown/core/domain/identity";
import type { AgentId } from "@keeltown/core/kernel";
import type { Hono } from "hono";
import type { AppEnv, RouteDeps } from "../../../generated/http/runtime.gen.ts";
import { isInboxCursor, sseEvent } from "../notices.ts";
import type { Caller } from "./caller.ts";
import { bootstrapConfined } from "./operator.ts";
import { problemResponse } from "./problems.ts";

/**
 * What the agent's live inbox routes need from composition. They are not in
 * the spec yet (http-zod caps `@typespec/streams`), so they sit beside the
 * generated routes and use the same auth gate.
 */
export interface InboxStreams {
  /** Notices after `cursor`, waiting up to `waitSeconds` for one: the Inbox port. */
  readonly read: (
    agentId: AgentId,
    cursor: string | undefined,
    waitSeconds: number,
    signal: AbortSignal,
  ) => Promise<InboxPage>;
  /** Hands a WebSocket upgrade to the agent's own AgentSession DO. */
  readonly socket: (agentId: AgentId, request: Request) => Promise<Response>;
}

export const INBOX_STREAM_PATH = "/v1/inbox/stream";
export const INBOX_SOCKET_PATH = "/v1/inbox/socket";

/** Both routes read the inbox, so both need `agent:read`, as `GET /v1/inbox` does. */
const AGENT_READ = [{ OAuth2Auth: ["agent:read"] }] as const;

/** How long one read of the SSE loop waits for a notice; an empty wait sends a keep-alive comment. */
const SSE_WAIT_SECONDS = 25;

const encoder = new TextEncoder();

/**
 * `GET /v1/inbox/stream` (SSE) and `GET /v1/inbox/socket` (WebSocket). The
 * principal comes only from the bearer token: a socket is forwarded to the
 * caller's own AgentSession, never to an object the request names.
 */
export function registerInboxStreams(
  app: Hono<AppEnv>,
  deps: RouteDeps<AppEnv, Caller>,
  streams: InboxStreams,
): void {
  const authorize = deps.authorize(AGENT_READ);

  app.get(INBOX_STREAM_PATH, authorize, (c) => {
    const caller = deps.context(c, "required");
    if (caller === null) return deps.noContext(c);
    const { principal } = caller;
    if (principal === null) return deps.noContext(c);
    if (isBootstrap(principal)) return confined(caller);
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

  app.get(INBOX_SOCKET_PATH, authorize, async (c) => {
    const caller = deps.context(c, "required");
    if (caller === null) return deps.noContext(c);
    const { principal } = caller;
    if (principal === null) return deps.noContext(c);
    if (isBootstrap(principal)) return confined(caller);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return problemResponse(400, "request.invalid", caller.requestId, {
        detail: "This route is a WebSocket: send `Upgrade: websocket`.",
      });
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !isInboxCursor(cursor)) return badCursor(caller);
    const upgraded = await streams.socket(principal.agentId, c.req.raw);
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

function confined(caller: Caller): Response {
  const { status, body } = bootstrapConfined(caller.requestId);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}
