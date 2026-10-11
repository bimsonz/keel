import type { AgentNotice, InboxPage } from "@keeltown/core/domain/identity";

/**
 * A notice as every doorway carries it: the spec's `Notice`, whether it rides
 * a tool result, fills an inbox page, or arrives on the agent's SSE stream or
 * WebSocket.
 */
export function noticeView(notice: AgentNotice) {
  return {
    id: notice.id,
    at: new Date(notice.at).toISOString(),
    kind: notice.kind,
    title: notice.title,
    ...(notice.detail === undefined ? {} : { detail: notice.detail }),
    ...(notice.ref === undefined ? {} : { ref: notice.ref }),
    ...(notice.cursor === undefined ? {} : { cursor: notice.cursor }),
  };
}

export type NoticeView = ReturnType<typeof noticeView>;

/**
 * One message on the agent's WebSocket. The first is always the `snapshot`:
 * every notice after the cursor the client connected with, sent in the same
 * turn the socket is accepted. Each later one carries the notices committed
 * since. `cursor` is where to reconnect from.
 */
export interface SocketFrame {
  readonly type: "snapshot" | "notices";
  readonly notices: readonly NoticeView[];
  readonly cursor: string;
}

export const socketFrame = (type: SocketFrame["type"], page: InboxPage): string =>
  JSON.stringify({
    type,
    notices: page.notices.map(noticeView),
    cursor: page.cursor,
  } satisfies SocketFrame);

/** A notice as one SSE event: its cursor is the event id, so `Last-Event-ID` resumes after it. */
export const sseEvent = (notice: AgentNotice): string =>
  `id: ${notice.cursor ?? ""}\nevent: notice\ndata: ${JSON.stringify(noticeView(notice))}\n\n`;

/** An inbox cursor: twelve digits. Anything else would read nothing, ever, so it is refused. */
export const isInboxCursor = (cursor: string): boolean => /^\d{12}$/.test(cursor);
