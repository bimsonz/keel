import { Effect, Schema } from "effect";
import { EventEnvelope } from "../../domain/kernel/index.ts";
import { EntityStore, type Stored } from "../ports/index.ts";

/**
 * The Projector's feed: every event Keel commits, as it arrives. Positions are
 * arrival order. Each emitter's events keep their commit order, because its
 * outbox delivers to one subscriber in order; there is no total causal order
 * across emitters.
 */
export const FEED = { kind: "feed", head: { kind: "feed-head", id: "self" } } as const;

/** The events one feed read answers with, unless it asks for fewer; never more than `FEED_PAGE_MAX`. */
export const FEED_PAGE = 100;
export const FEED_PAGE_MAX = 500;

export interface FeedPage {
  readonly events: readonly EventEnvelope[];
  /** The last position read; an empty page keeps the cursor it was given. */
  readonly cursor: string;
}

/** Positions sort as strings; the cursor is the last position read. */
const position = (n: number) => String(n).padStart(12, "0");

type Store = (typeof EntityStore)["Service"];

const encode = Schema.encodeSync(EventEnvelope);
const decode = Schema.decodeUnknownSync(EventEnvelope);

const headOf = (store: Store): number => {
  const head = store.get(FEED.head.kind, FEED.head.id);
  return typeof head === "number" ? head : 0;
};

/** Records an arrived event at the feed's next position. Synchronous: it runs inside the receipt's transaction. */
export function recordFeed(store: Store, event: EventEnvelope): void {
  const next = headOf(store) + 1;
  const stored: Stored = JSON.parse(JSON.stringify(encode(event)));
  store.put(FEED.kind, position(next), stored);
  store.put(FEED.head.kind, FEED.head.id, next);
}

/** The events after `cursor`, oldest first, at most `limit` (1–500). Positions are dense, so each is read by key. */
export const readFeed: (
  cursor: string | undefined,
  limit?: number,
) => Effect.Effect<FeedPage, never, EntityStore> = Effect.fn("memory/readFeed")(function* (
  cursor: string | undefined,
  limit: number = FEED_PAGE,
) {
  const store = yield* EntityStore;
  const after = cursor === undefined ? 0 : Number(cursor);
  const last = Math.min(headOf(store), after + Math.min(Math.max(limit, 1), FEED_PAGE_MAX));
  const events: EventEnvelope[] = [];
  for (let at = after + 1; at <= last; at += 1) {
    const stored = store.get(FEED.kind, position(at));
    if (stored !== undefined) events.push(decode(stored));
  }
  return { events, cursor: last > after ? position(last) : position(after) };
});
