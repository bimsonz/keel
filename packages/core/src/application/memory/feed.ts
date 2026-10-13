import { Effect, Schema } from "effect";
import { EventEnvelope } from "../../domain/kernel/index.ts";
import { EntityStore, type Stored } from "../ports/index.ts";

/**
 * The Projector's feed: every event Keel commits, as it arrives. Positions are
 * arrival order. Each emitter's events keep their commit order, because its
 * outbox delivers to one subscriber in order; there is no total causal order
 * across emitters.
 */
export const FEED = {
  kind: "feed",
  head: { kind: "feed-head", id: "self" },
  /** The short label of the entry at a position, when it has one. */
  label: "feed-label",
  /** Per project and kind: the last number given out. */
  counter: "label-counter",
  /** Per project, kind and entity: the label it was given, so it is given once. */
  given: "label-given",
} as const;

/** The events one feed read answers with, unless it asks for fewer; never more than `FEED_PAGE_MAX`. */
export const FEED_PAGE = 100;
export const FEED_PAGE_MAX = 500;

/** One feed entry: the event, and the short label the Projector gave it if it creates something people name. */
export type FeedEntry = EventEnvelope & { readonly label?: string };

export interface FeedPage {
  readonly events: readonly FeedEntry[];
  /** The last position read; an empty page keeps the cursor it was given. */
  readonly cursor: string;
}

/**
 * What the console names with a short label, by the event that creates it: the
 * label's prefix and the payload field holding the named entity's id. Numbers
 * count per project and prefix: `#12` is the project's twelfth change, `C-3`
 * its third conflict.
 */
const LABELLED: Readonly<
  Record<
    string,
    {
      readonly prefix: string;
      readonly id: string;
      readonly creates?: (payload: Readonly<Record<string, unknown>>) => boolean;
    }
  >
> = {
  IntentDeclared: { prefix: "#", id: "changeId" },
  DecisionRecorded: { prefix: "D-", id: "decisionId" },
  GuardAdmitted: { prefix: "G-", id: "guardId" },
  ConflictSuspected: { prefix: "C-", id: "conflictId" },
  EscalationRaised: { prefix: "E-", id: "escalationId" },
  ProbeDrafted: { prefix: "P-", id: "probeId" },
  // A probe whose drafts all failed begins and ends with this event.
  ProbeDiscarded: {
    prefix: "P-",
    id: "probeId",
    creates: (payload) => payload.reason === "draft-failed",
  },
};

/** Positions sort as strings; the cursor is the last position read. */
const position = (n: number) => String(n).padStart(12, "0");

type Store = (typeof EntityStore)["Service"];

const encode = Schema.encodeSync(EventEnvelope);
const decode = Schema.decodeUnknownSync(EventEnvelope);

const headOf = (store: Store): number => {
  const head = store.get(FEED.head.kind, FEED.head.id);
  return typeof head === "number" ? head : 0;
};

/** The feed's head as a cursor: a read from it returns only what arrives after. */
export const feedCursor = (store: Store): string => position(headOf(store));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The label for an event that creates something the console names, given the
 * first time the Projector records that thing's creation in its project:
 * `D-n` decisions, `G-n` guards, `C-n` conflicts, `E-n` escalations, `P-n`
 * probes and `#n` changes. An event of no project gets none.
 */
function labelFor(store: Store, event: EventEnvelope): string | undefined {
  const rule = LABELLED[event.type];
  const { payload, project } = event;
  if (rule === undefined || project === undefined || !isRecord(payload)) return undefined;
  if (rule.creates !== undefined && !rule.creates(payload)) return undefined;
  const id = payload[rule.id];
  if (typeof id !== "string") return undefined;
  const given = `${project}/${rule.prefix}/${id}`;
  const already = store.get(FEED.given, given);
  if (typeof already === "string") return already;
  const counter = `${project}/${rule.prefix}`;
  const last = store.get(FEED.counter, counter);
  const count = (typeof last === "number" ? last : 0) + 1;
  const label = `${rule.prefix}${count}`;
  store.put(FEED.counter, counter, count);
  store.put(FEED.given, given, label);
  return label;
}

/** The label the feed gave something of a project when it recorded its creation, by the prefix of its kind (`E-`, `C-` …). */
export function labelGiven(
  store: Store,
  project: string,
  prefix: string,
  id: string,
): string | undefined {
  const label = store.get(FEED.given, `${project}/${prefix}/${id}`);
  return typeof label === "string" ? label : undefined;
}

/**
 * Records an arrived event at the feed's next position, with its label if it
 * gets one. Synchronous: it runs inside the receipt's transaction, so a
 * redelivery (a no-op receipt) never numbers anything twice.
 */
export function recordFeed(store: Store, event: EventEnvelope): void {
  const next = headOf(store) + 1;
  const stored: Stored = JSON.parse(JSON.stringify(encode(event)));
  store.put(FEED.kind, position(next), stored);
  store.put(FEED.head.kind, FEED.head.id, next);
  const label = labelFor(store, event);
  if (label !== undefined) store.put(FEED.label, position(next), label);
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
  const events: FeedEntry[] = [];
  for (let at = after + 1; at <= last; at += 1) {
    const stored = store.get(FEED.kind, position(at));
    if (stored === undefined) continue;
    const label = store.get(FEED.label, position(at));
    events.push(typeof label === "string" ? { ...decode(stored), label } : decode(stored));
  }
  return { events, cursor: last > after ? position(last) : position(after) };
});
