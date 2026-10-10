import { Context, type Effect } from "effect";
import type { EventEnvelope } from "../../domain/kernel/index.ts";

/** The operation log, for replay and projections. Distribution only, **never the source of truth**. */
export class EventLog extends Context.Service<EventLog, {
  readonly publish: (events: readonly EventEnvelope[]) => Effect.Effect<void>;
}>()("keel/EventLog") {}
