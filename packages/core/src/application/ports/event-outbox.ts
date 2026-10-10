import { Context, type Effect } from "effect";
import type { EventEnvelope } from "../../domain/kernel/index.ts";

/**
 * Events waiting to fan out. `append` is synchronous so it runs inside the same
 * `EntityStore.transaction` as the state it describes; `drain` hands committed
 * events to their destinations afterwards.
 */
export class EventOutbox extends Context.Service<EventOutbox, {
  readonly append: (events: readonly EventEnvelope[]) => void;
  readonly pending: (limit: number) => readonly EventEnvelope[];
  readonly acknowledge: (eventIds: readonly string[]) => Effect.Effect<void>;
}>()("keel/EventOutbox") {}
