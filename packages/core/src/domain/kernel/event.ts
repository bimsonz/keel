import type { Result } from "effect";
import { Schema } from "effect";
import { EntityRef } from "./entity.ts";
import { AgentId, EventId, type Instant, InstantSchema } from "./ids.ts";

/**
 * The principal whose command an event records: an agent, or an operator by
 * name. Absent when the platform caused the event (Precheck, an alarm, a
 * reaction, the Lane landing a change). An agent is never notified of an event
 * it caused, because its own tool result already reports it.
 */
export const Actor = Schema.Union([
  Schema.TemplateLiteral(["agent:", AgentId]),
  Schema.TemplateLiteral(["operator:", Schema.NonEmptyString]),
]);
export type Actor = typeof Actor.Type;

/** The actor an agent's own commands commit under. */
export const agentActor = (agentId: AgentId): Actor => `agent:${agentId}`;

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
  actor: Schema.optional(Actor),
  affected: Schema.Array(EntityRef),
  notified: Schema.Array(Schema.String),
  payload: Schema.Unknown,
});
export type EventEnvelope = typeof EventEnvelope.Type;

/**
 * A state machine's decision: given the current state, a command and the facts
 * looked up beforehand (the time, the result of any read), the events to
 * commit, or why not. Pure and synchronous, so a Durable Object's decision
 * path never awaits; the domain never reads a clock or mints an id itself.
 */
export type Decide<State, Command, Event, Rejection, Facts = void> = (
  state: State,
  command: Command,
  facts: Facts,
) => Result.Result<readonly Event[], Rejection>;

/** Folds one committed event into the state. Replaying an entity's events rebuilds it exactly. */
export type Evolve<State, Event> = (state: State, event: Event) => State;

/**
 * An event as its transaction committed it: the payload and the commit time,
 * the two envelope fields a machine's `evolve` reads. An `EventEnvelope` with
 * its payload decoded is one.
 */
export interface Committed<Event> {
  readonly at: Instant;
  readonly payload: Event;
}

/**
 * Thrown by `evolve` for an event its state cannot take. A defect, never a
 * refusal: `decide` refuses commands, so a log holding such an event is corrupt.
 */
export class IllegalTransition extends Error {
  readonly _tag = "IllegalTransition";
}
