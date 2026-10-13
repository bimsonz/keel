import type { Result } from "effect";
import { Schema } from "effect";
import { EntityRef } from "./entity.ts";
import { AgentId, EventId, type Instant, InstantSchema, ProjectId, RunRef, UserId } from "./ids.ts";

/**
 * The principal whose command an event records: an agent or a user, each by
 * id. Absent when the platform caused the event (Precheck, an alarm, a
 * reaction, the Lane landing a change). An agent is never notified of an event
 * it caused, because its own tool result already reports it.
 *
 * `operator:<name>` is how events named a person before users existed. The
 * events already stored carry it, so it is still read.
 */
export const Actor = Schema.Union([
  Schema.TemplateLiteral(["agent:", AgentId]),
  Schema.TemplateLiteral(["user:", UserId]),
  Schema.TemplateLiteral(["operator:", Schema.NonEmptyString]),
]);
export type Actor = typeof Actor.Type;

/** The actor an agent's own commands commit under. */
export const agentActor = (agentId: AgentId): Actor => `agent:${agentId}`;

/**
 * Whose command an agent's commit is: the agent, and the run of it that asked
 * when its token names one. Every commit an agent causes takes both from here,
 * so an event never names the agent and loses its run.
 */
export const byAgent = (
  agentId: AgentId,
  run: RunRef | undefined,
): { readonly actor: Actor; readonly run?: RunRef } => ({
  actor: agentActor(agentId),
  ...(run === undefined ? {} : { run }),
});

/** The actor a user's own commands commit under: a maintainer's withdrawal, an owner's settings. */
export const userActor = (userId: UserId): Actor => `user:${userId}`;

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
  /**
   * The run of the agent whose command this was: one agent has any
   * number at once, and each event says which. Absent when the actor is a user
   * or the platform, and for an agent's token that names no run.
   */
  run: Schema.optional(RunRef),
  /** The project the emitting entity belongs to. Absent only for events no project owns. */
  project: Schema.optional(ProjectId),
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
