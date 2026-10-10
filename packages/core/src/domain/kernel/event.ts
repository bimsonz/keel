import type { Result } from "effect";
import { Schema } from "effect";
import { EntityRef } from "./entity.ts";
import { EventId, InstantSchema } from "./ids.ts";

/**
 * The envelope every event is committed in (docs/domain/events.md). The payload
 * is one of the contexts' tagged event schemas; its `_tag` is the event type.
 */
export const EventEnvelope = Schema.Struct({
  eventId: EventId,
  type: Schema.NonEmptyString,
  entity: EntityRef,
  seq: Schema.Int,
  at: InstantSchema,
  dedupeKey: Schema.NonEmptyString,
  causation: Schema.optional(EventId),
  affected: Schema.Array(EntityRef),
  notified: Schema.Array(Schema.String),
  payload: Schema.Unknown,
});
export type EventEnvelope = typeof EventEnvelope.Type;

/**
 * A state machine's decision: given the current state and a command (with any
 * facts looked up beforehand), the events to commit, or why not. Pure and
 * synchronous, so a Durable Object's decision path never awaits.
 */
export type Decide<State, Command, Event, Rejection> = (
  state: State,
  command: Command,
) => Result.Result<readonly Event[], Rejection>;

/** Folds one committed event into the state. Replaying an entity's events rebuilds it exactly. */
export type Evolve<State, Event> = (state: State, event: Event) => State;
