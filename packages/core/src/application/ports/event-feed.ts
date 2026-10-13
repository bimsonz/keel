import { Context, type Effect } from "effect";
import type { EventEnvelope, ProjectId } from "../../domain/kernel/index.ts";

/** One event on the feed, with the short label the Projector gave it when it creates something people name (`#n`, `D-n` …). */
export type EventFeedEntry = EventEnvelope & { readonly label?: string | undefined };

export interface EventFeedPage {
  readonly events: readonly EventFeedEntry[];
  /**
   * The position just after the last event returned, or the cursor read from
   * when there were none: always present, so a reader never restarts the feed.
   * A read by project moves past other projects' events: its cursor is the
   * last event returned when `limit` cut the page, and otherwise the position
   * the feed has indexed the project to (the head, once the index is level).
   */
  readonly cursor: string;
}

export interface EventFeedRead {
  /**
   * Twelve digits, or `end` for the feed's head as the read finds it (no
   * events, and the cursor to read on from; with a wait, the next arrival).
   * Absent reads from the feed's start.
   */
  readonly cursor?: string;
  /** 1–500; absent is 100. */
  readonly limit?: number;
  /** With a wait above 0 and nothing after `cursor`, the read answers on the next arrival or an empty page at the deadline. */
  readonly waitSeconds: number;
  /**
   * Only this project's events, sought through its own index: a page is the
   * project's next `limit`, whatever else the feed holds, and a waiting read
   * is answered by the project's next arrival and by no other's.
   */
  readonly project?: ProjectId;
}

/**
 * Every event Keel commits, in arrival order, from the Projector DO. Each
 * emitter's events keep their commit order; there is no total causal order
 * across emitters. Mission Control's live feed and `GET /v1/events`.
 */
export class EventFeed extends Context.Service<
  EventFeed,
  { readonly read: (request: EventFeedRead) => Effect.Effect<EventFeedPage> }
>()("keel/EventFeed") {}
