import { Schema } from "effect";
import {
  type AgentId,
  agentActor,
  EntityRef,
  EventId,
  type EventEnvelope,
  InstantSchema,
  NextAction,
} from "../kernel/index.ts";

/** One notice for an agent: what reaches its inbox, its next tool result, or its stream. */
export const AgentNotice = Schema.Struct({
  id: Schema.String,
  at: InstantSchema,
  kind: Schema.String,
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  /** What the agent can do about it, as the event that caused the notice named them. Absent when it named none. */
  nextActions: Schema.optional(Schema.Array(NextAction)),
  /** The notice's inbox position: reading the inbox from here returns only what is newer. */
  cursor: Schema.optional(Schema.String),
});
export type AgentNotice = typeof AgentNotice.Type;

/** A page of an agent's inbox, oldest first; `cursor` resumes after the last notice. */
export const InboxPage = Schema.Struct({
  notices: Schema.Array(AgentNotice),
  cursor: Schema.String,
});
export type InboxPage = typeof InboxPage.Type;

/** One event delivered to the agent, as its AgentSession DO keeps it. */
export const InboxEntry = Schema.Struct({
  eventId: EventId,
  type: Schema.NonEmptyString,
  entity: EntityRef,
  seq: Schema.Int,
  at: InstantSchema,
  /** More than the title says, chosen when the event is delivered. */
  detail: Schema.optional(Schema.String),
  /** The event's next actions, kept when it is delivered so the notice can carry them. */
  nextActions: Schema.optional(Schema.Array(NextAction)),
});
export type InboxEntry = typeof InboxEntry.Type;

/** `ChangeBounced` reads as "Change bounced". */
const sentence = (type: string): string => {
  const words = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The notice the inbox entry at `position` becomes: what happened, to which
 * entity, and where it sits, with the entry's detail and next actions as they
 * are. An entry with no next actions, or an empty list, gives a notice with none.
 */
export const noticeOf = (entry: InboxEntry, position: string): AgentNotice => ({
  id: entry.eventId,
  at: entry.at,
  kind: entry.type,
  title: `${sentence(entry.type)}: ${entry.entity.id}`,
  ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  ref: `${entry.entity.kind}:${entry.entity.id}`,
  ...(entry.nextActions === undefined || entry.nextActions.length === 0
    ? {}
    : { nextActions: entry.nextActions }),
  cursor: position,
});

const isAnnotation = Schema.is(
  Schema.Struct({ _tag: Schema.Literal("ConflictNoted"), policy: Schema.Literal("annotate") }),
);

/**
 * No self-loops: an agent is never notified of an event it caused, because its
 * own tool result already reported it. So it is never woken by its own push,
 * and a fix → notice → fix loop cannot form. A conflict noted under `annotate`
 * is recorded for the record only, so it notifies no one.
 */
export const notifies = (agentId: AgentId, event: EventEnvelope): boolean =>
  event.actor !== agentActor(agentId) && !isAnnotation(event.payload);
