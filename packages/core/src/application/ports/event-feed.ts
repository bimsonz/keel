import { Context, type Effect } from "effect";
import type { EventEnvelope } from "../../domain/kernel/index.ts";

/** One event on the feed, with the short label the Projector gave it when it creates something people name (`#n`, `D-n` …). */
export type EventFeedEntry = EventEnvelope & { readonly label?: string | undefined };

export interface EventFeedPage {
  readonly events: readonly EventFeedEntry[];
  /**
   * The position just after the last event returned, or the cursor read from
   * when there were none: always present, so a reader never restarts the feed.
   */
  readonly cursor: string;
}

export interface EventFeedRead {
  /** Twelve digits; absent reads from the feed's start. */
  readonly cursor?: string;
  /** 1–500; absent is 100. */
  readonly limit?: number;
  /** With a wait above 0 and nothing after `cursor`, the read answers on the next arrival or an empty page at the deadline. */
  readonly waitSeconds: number;
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
