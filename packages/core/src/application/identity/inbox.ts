import { Effect, Schema } from "effect";
import {
  type InboxEntry,
  InboxEntry as InboxEntrySchema,
  type InboxPage,
  noticeOf,
} from "../../domain/identity/index.ts";
import type { EventEnvelope } from "../../domain/kernel/index.ts";
import { EntityStore } from "../ports/index.ts";

/** Where an agent's inbox lives in its AgentSession DO's store: one entry per delivered event, by position. */
export const INBOX = { kind: "inbox", head: { kind: "inbox-head", id: "self" } } as const;

/** The most notices one inbox read answers with. */
export const INBOX_PAGE = 50;

/** Positions sort as strings; the cursor is the last position read. */
const position = (n: number) => String(n).padStart(12, "0");
const START = position(0);

type Store = (typeof EntityStore)["Service"];

/** Records a delivered event as the inbox's next entry. Synchronous: it runs inside the reaction's transaction. */
export function recordDelivery(store: Store, event: EventEnvelope): void {
  const head = store.get(INBOX.head.kind, INBOX.head.id);
  const next = (typeof head === "number" ? head : 0) + 1;
  const entry: typeof InboxEntrySchema.Encoded = {
    eventId: event.eventId,
    type: event.type,
    entity: event.entity,
    seq: event.seq,
    at: event.at,
  };
  store.put(INBOX.kind, position(next), entry);
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

/** A page of notices after `cursor`. An empty page keeps the cursor where it was. */
export const readInbox: (
  cursor: string | undefined,
) => Effect.Effect<InboxPage, never, EntityStore> = Effect.fn("identity/readInbox")(function* (
  cursor: string | undefined,
) {
  const store = yield* EntityStore;
  const entries = entriesAfter(store, cursor);
  return {
    notices: entries.map(({ entry }) => noticeOf(entry)),
    cursor: entries.at(-1)?.position ?? cursor ?? START,
  };
});
