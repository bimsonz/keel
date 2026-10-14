import { Effect, Schema } from "effect";
import { EventEnvelope, type ProjectId } from "../../domain/kernel/index.ts";
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
  /** A project's entries in arrival order: `<project>/<n>` → the entry's position in the feed. Dense per project. */
  byProject: "feed-project",
  /** Per project: how many of its entries are indexed. */
  projectHead: "feed-project-head",
  /** The position the index by project is complete to. */
  indexed: { kind: "feed-indexed", id: "self" },
} as const;

/**
 * The positions one receipt, or one read by project, indexes at most. A feed
 * recorded before the index existed is caught up in steps of this size, never
 * in one long transaction.
 */
export const FEED_INDEX_STEP = 5_000;

/** The events one feed read answers with, unless it asks for fewer; never more than `FEED_PAGE_MAX`. */
export const FEED_PAGE = 100;
export const FEED_PAGE_MAX = 500;

/** One feed entry: the event, and the short label the Projector gave it if it creates something people name. */
export type FeedEntry = EventEnvelope & { readonly label?: string };

export interface FeedPage {
  readonly events: readonly FeedEntry[];
  /**
   * The last position read; an empty page keeps the cursor it was given. A
   * read by project moves past other projects' events: its cursor is the last
   * entry returned when the limit cut the page, and otherwise the position
   * the project's index is complete to.
   */
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

/** The feed's head: the position of its last entry, 0 while it is empty. */
export const feedHead = (store: Store): number => headOf(store);

/** The entry the feed holds at a position, decoded, with its label when it has one. */
export const feedEntry = (store: Store, at: number): FeedEntry | undefined => entryAt(store, at);

/** The event the feed holds at a position, as stored: undecoded, so a reader can look at its `type` first. */
export const storedAt = (store: Store, at: number): Stored | undefined =>
  store.get(FEED.kind, position(at));

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

const indexedTo = (store: Store): number => {
  const indexed = store.get(FEED.indexed.kind, FEED.indexed.id);
  return typeof indexed === "number" ? indexed : 0;
};

const projectHeadOf = (store: Store, project: string): number => {
  const head = store.get(FEED.projectHead, project);
  return typeof head === "number" ? head : 0;
};

/**
 * Indexes the feed's next positions by project, at most `step` of them, in
 * position order, so each project's index is dense and in arrival order.
 * Answers the position the index is now complete to: the head, once it is
 * level. It writes, so it runs inside a transaction: the receipt's, or a read
 * by project's own.
 */
export function indexFeed(store: Store, step: number = FEED_INDEX_STEP): number {
  const from = indexedTo(store);
  const to = Math.min(headOf(store), from + step);
  if (to <= from) return from;
  for (let at = from + 1; at <= to; at += 1) {
    const stored = store.get(FEED.kind, position(at));
    const project = isRecord(stored) ? stored["project"] : undefined;
    if (typeof project !== "string") continue;
    const count = projectHeadOf(store, project) + 1;
    store.put(FEED.byProject, `${project}/${position(count)}`, at);
    store.put(FEED.projectHead, project, count);
  }
  store.put(FEED.indexed.kind, FEED.indexed.id, to);
  return to;
}

/**
 * Records an arrived event at the feed's next position, with its label if it
 * gets one, and indexes it under its project (with a step of any backlog
 * recorded before the index existed). Synchronous: it runs inside the
 * receipt's transaction, so a redelivery (a no-op receipt) never numbers
 * anything twice.
 */
export function recordFeed(store: Store, event: EventEnvelope): void {
  const next = headOf(store) + 1;
  const stored: Stored = JSON.parse(JSON.stringify(encode(event)));
  store.put(FEED.kind, position(next), stored);
  store.put(FEED.head.kind, FEED.head.id, next);
  const label = labelFor(store, event);
  if (label !== undefined) store.put(FEED.label, position(next), label);
  indexFeed(store);
}

/** The entry at a position with its label, when the feed holds one there. */
const entryAt = (store: Store, at: number): FeedEntry | undefined => {
  const stored = store.get(FEED.kind, position(at));
  if (stored === undefined) return undefined;
  const label = store.get(FEED.label, position(at));
  return typeof label === "string" ? { ...decode(stored), label } : decode(stored);
};

/**
 * A project's events after `after`, oldest first, at most `max`: its index is
 * searched for its first entry past the cursor, and the entries are read by
 * key, so a page costs the project's own entries and never the feed's. The
 * index is moved a step first. While it is behind the head (a feed recorded
 * before it existed), the page holds only what is indexed and its cursor
 * never passes the indexed position, so nothing between is skipped.
 */
function readProject(store: Store, project: ProjectId, after: number, max: number): FeedPage {
  const indexed = store.transaction(() => indexFeed(store));
  const count = projectHeadOf(store, project);
  const positionOf = (n: number): number => {
    const at = store.get(FEED.byProject, `${project}/${position(n)}`);
    return typeof at === "number" ? at : 0;
  };
  // The first of the project's entries after the cursor, by binary search.
  let low = 1;
  let high = count + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (positionOf(middle) > after) high = middle;
    else low = middle + 1;
  }
  const events: FeedEntry[] = [];
  let last = after;
  let n = low;
  for (; n <= count && events.length < max; n += 1) {
    last = positionOf(n);
    const entry = entryAt(store, last);
    if (entry !== undefined) events.push(entry);
  }
  // Cut by the limit, more of the project's follow the last one returned; otherwise the reader has all that is indexed.
  return { events, cursor: position(n <= count ? last : Math.max(indexed, after)) };
}

/** The cursor that names the feed's head, wherever it is when the read is taken. */
export const FEED_END = "end";

/**
 * The events after `cursor`, oldest first, at most `limit` (1–500). Positions
 * are dense, so each is read by key. With `project`, only that project's
 * events, sought through its index (`readProject`).
 *
 * The cursor `end` answers no events and the position to read on from: the
 * feed's head, or for a read by project the position its index is complete to
 * (after a step of it), never past it, so reading on from there skips nothing
 * of the project's that the index has yet to reach. A read that waits from
 * `end` takes this answer once and waits on from its cursor.
 */
export const readFeed: (
  cursor: string | undefined,
  limit?: number,
  project?: ProjectId,
) => Effect.Effect<FeedPage, never, EntityStore> = Effect.fn("memory/readFeed")(function* (
  cursor: string | undefined,
  limit: number = FEED_PAGE,
  project?: ProjectId,
) {
  const store = yield* EntityStore;
  if (cursor === FEED_END) {
    const end = project === undefined ? headOf(store) : store.transaction(() => indexFeed(store));
    return { events: [], cursor: position(end) };
  }
  const after = cursor === undefined ? 0 : Number(cursor);
  const max = Math.min(Math.max(limit, 1), FEED_PAGE_MAX);
  if (project !== undefined) return readProject(store, project, after, max);
  const last = Math.min(headOf(store), after + max);
  const events: FeedEntry[] = [];
  for (let at = after + 1; at <= last; at += 1) {
    const entry = entryAt(store, at);
    if (entry !== undefined) events.push(entry);
  }
  return { events, cursor: last > after ? position(last) : position(after) };
});
