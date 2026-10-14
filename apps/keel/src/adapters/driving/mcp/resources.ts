import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { Caller } from "../http/caller.ts";
import type { Handlers } from "../http/handlers.ts";
import { FEED_TEMPLATE, INBOX_URI } from "./listen.ts";

/**
 * The most pages `keel://inbox` reads to reach the newest: 2,000 notices.
 * An inbox longer than that is answered at the last page read, and its
 * cursor reads on.
 */
export const MAX_INBOX_PAGES = 40;

/** A handler's answer as a resource's contents: its body as JSON, or the refusal as an MCP error. */
function contents(
  uri: URL,
  answer: { readonly status: number; readonly body: unknown },
): { contents: [{ uri: string; mimeType: string; text: string }] } {
  if (answer.status >= 400) {
    const { body } = answer;
    const detail =
      typeof body === "object" &&
      body !== null &&
      "detail" in body &&
      typeof body.detail === "string"
        ? body.detail
        : `Refused with ${answer.status}`;
    throw new ProtocolError(
      answer.status >= 500 ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams,
      detail,
      body,
    );
  }
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(answer.body) }],
  };
}

/**
 * The two resources an agent watches, each read through the same handler
 * object as REST, so the one policy decides who reads them.
 */
export function registerResources(
  server: McpServer,
  handlers: Handlers,
  callerOf: (signal: AbortSignal) => Caller,
): void {
  server.registerResource(
    "inbox",
    INBOX_URI,
    {
      title: "Your inbox",
      description:
        "The newest page of notices for this token's agent and run, read as the `inbox` tool reads it: what it answers counts as read. Read on from its cursor with the `inbox` tool.",
      mimeType: "application/json",
    },
    async (uri, context) => {
      const caller = callerOf(context.http?.req?.signal ?? context.mcpReq.signal);
      let page = await handlers.inbox(caller, {});
      // Read to the last page that has notices: reading it is the agent reading, as through the tool.
      for (let pages = 1; pages < MAX_INBOX_PAGES; pages += 1) {
        if (page.status !== 200 || page.body.result.notices.length === 0) break;
        // oxlint-disable-next-line no-await-in-loop -- each page is read from the cursor the one before answered
        const next = await handlers.inbox(caller, { cursor: page.body.result.cursor });
        if (next.status === 200 && next.body.result.notices.length === 0) break;
        page = next;
      }
      return contents(uri, page);
    },
  );
  server.registerResource(
    "events",
    new ResourceTemplate(FEED_TEMPLATE, { list: undefined }),
    {
      title: "A project's events",
      description:
        "The project's feed at its head: no events, and the cursor to read on from. Keep the cursor and read on from it with the `Inbox_listEvents` tool.",
      mimeType: "application/json",
    },
    async (uri, variables, context) => {
      const { projectId } = variables;
      const project = Array.isArray(projectId) ? projectId[0] : projectId;
      const caller = callerOf(context.http?.req?.signal ?? context.mcpReq.signal);
      return contents(
        uri,
        await handlers.Inbox_listEvents(caller, {
          ...(project === undefined ? {} : { project }),
          cursor: "end",
        }),
      );
    },
  );
}
