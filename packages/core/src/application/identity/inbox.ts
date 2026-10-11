import { Effect, Schema } from "effect";
import {
  type AgentNotice,
  type InboxEntry,
  InboxEntry as InboxEntrySchema,
  type InboxPage,
  noticeOf,
} from "../../domain/identity/index.ts";
import type { EventEnvelope } from "../../domain/kernel/index.ts";
import { EntityStore, type Stored } from "../ports/index.ts";

/**
 * Where an agent's inbox lives in its AgentSession DO's store: one entry per
 * delivered event, by position, and the `piggybacked` cursor: the last
 * position a tool result carried or an inbox read returned.
 */
export const INBOX = {
  kind: "inbox",
  head: { kind: "inbox-head", id: "self" },
  piggybacked: { kind: "inbox-piggybacked", id: "self" },
} as const;

/** The most notices one inbox read answers with. */
export const INBOX_PAGE = 50;

/** The most notices one tool result carries: the agent envelope's `notices`. */
export const PIGGYBACK_MAX = 3;

/** Positions sort as strings; the cursor is the last position read. */
const position = (n: number) => String(n).padStart(12, "0");
const START = position(0);
const POSITION = /^\d{12}$/;

type Store = (typeof EntityStore)["Service"];

/** An entry as the store keeps it: its optional fields are left out, never stored as undefined. */
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

const headOf = (store: Store): number => {
  const head = store.get(INBOX.head.kind, INBOX.head.id);
  return typeof head === "number" ? head : 0;
};

const piggybackedOf = (store: Store): string => {
  const at = store.get(INBOX.piggybacked.kind, INBOX.piggybacked.id);
  return typeof at === "string" ? at : START;
};

/**
 * How many notices wait unread: those after the `piggybacked` cursor.
 * Positions are dense from 1 to the head, and reads clamp the cursor to it.
 */
export const inboxDepth = (store: Store): number => headOf(store) - Number(piggybackedOf(store));

/** Records a delivered event as the inbox's next entry. Synchronous: it runs inside the reaction's transaction. */
export function recordDelivery(store: Store, event: EventEnvelope): void {
  const next = headOf(store) + 1;
  const entry: typeof InboxEntrySchema.Encoded = {
    eventId: event.eventId,
    type: event.type,
    entity: event.entity,
    seq: event.seq,
    at: event.at,
  };
  store.put(INBOX.kind, position(next), asStored(entry));
  store.put(INBOX.head.kind, INBOX.head.id, next);
}

/** The inbox's entries after `cursor`, oldest first, at most `limit`. */
export function entriesAfter(
  store: Store,
  cursor: string | undefined,
  limit = INBOX_PAGE,
): readonly { readonly position: string; readonly entry: InboxEntry }[] {
  const from = cursor ?? START;
  return store
    .list(INBOX.kind)
    .filter((row) => row.id > from)
    .toSorted((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((row) => ({
      position: row.id,
      entry: Schema.decodeUnknownSync(InboxEntrySchema)(row.value),
    }));
}

/**
 * Moves `piggybacked` up to `cursor`: never back, and never past the newest
 * entry, so a cursor the agent made up cannot silence notices still to come.
 */
function markRead(store: Store, cursor: string): void {
  if (!POSITION.test(cursor)) return;
  const head = position(headOf(store));
  const read = cursor > head ? head : cursor;
  if (read > piggybackedOf(store)) store.put(INBOX.piggybacked.kind, INBOX.piggybacked.id, read);
}

/**
 * A page of notices after `cursor`. An empty page keeps the cursor where it
 * was. In the same transaction `piggybacked` moves up to the page's cursor, so
 * a notice the agent has read never rides a later tool result.
 */
export const readInbox: (
  cursor: string | undefined,
) => Effect.Effect<InboxPage, never, EntityStore> = Effect.fn("identity/readInbox")(function* (
  cursor: string | undefined,
) {
  const store = yield* EntityStore;
  return store.transaction((): InboxPage => {
    const entries = entriesAfter(store, cursor);
    const page = {
      notices: entries.map(({ entry, position: at }) => noticeOf(entry, at)),
      cursor: entries.at(-1)?.position ?? cursor ?? START,
    };
    markRead(store, page.cursor);
    return page;
  });
});

/**
 * The piggyback: up to `limit` (at most 3) notices that no tool result has
 * carried and no inbox read has returned, oldest first. Taking them moves
 * `piggybacked` past them in the same transaction, so each rides at most one
 * tool result; the inbox still holds every one.
 */
export const takeNotices: (
  limit: number,
) => Effect.Effect<readonly AgentNotice[], never, EntityStore> = Effect.fn("identity/takeNotices")(
  function* (limit: number) {
    const store = yield* EntityStore;
    return store.transaction((): readonly AgentNotice[] => {
      const entries = entriesAfter(
        store,
        piggybackedOf(store),
        Math.min(Math.max(limit, 0), PIGGYBACK_MAX),
      );
      const last = entries.at(-1);
      if (last !== undefined)
        store.put(INBOX.piggybacked.kind, INBOX.piggybacked.id, last.position);
      return entries.map(({ entry, position: at }) => noticeOf(entry, at));
    });
  },
);
