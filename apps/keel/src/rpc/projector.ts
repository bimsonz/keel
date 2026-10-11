import { EventEnvelope } from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** A feed position: twelve digits, so positions sort as strings. */
const Position = Schema.String.check(Schema.isPattern(/^\d{12}$/));

/** Read the feed after `cursor` (from its start when absent): at most `limit` (1–500, default 100) events, waiting up to `waitMs` (0–30,000) for one. */
export const ProjectorRead = Schema.Struct({
  cursor: Schema.optional(Position),
  limit: Schema.optional(Schema.Int),
  waitMs: Schema.optional(Schema.Int),
});

/** A page of the feed: the events after the cursor read, and the cursor to read on from. */
export const FeedPage = Schema.Struct({
  events: Schema.Array(EventEnvelope),
  cursor: Position,
});

export const ProjectorCodecs = {
  nudge: exitCodec(Schema.Struct({ drained: Schema.Int }), Schema.Never),
  read: exitCodec(FeedPage, Schema.Never),
};

/**
 * The Projector DO (`projector`). At L1 every Keel object delivers every event
 * it commits here, and the Projector keeps them as one feed for the console.
 * Positions are arrival order: each emitter's events keep their commit order,
 * but there is no total causal order across emitters. It drains the operation
 * log into read models when nudged, then sleeps.
 */
export interface ProjectorRpc extends EventReceiverRpc {
  nudge(): Promise<ExitJson>;
  /** The events after `cursor`; with `waitMs` above 0 and none yet, the first page an arrival brings, or an empty one at the deadline. */
  read(request: typeof ProjectorRead.Encoded): Promise<ExitJson>;
}
