import { Schema } from "effect";
import { EntityRef, EventId, InstantSchema } from "../kernel/index.ts";

/** One notice for an agent: what reaches its inbox, its next tool result, or its stream. */
export const AgentNotice = Schema.Struct({
  id: Schema.String,
  at: InstantSchema,
  kind: Schema.String,
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
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
});
export type InboxEntry = typeof InboxEntry.Type;

/** `ChangeBounced` reads as "Change bounced". */
const sentence = (type: string): string => {
  const words = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The notice an inbox entry becomes: what happened, and to which entity. */
export const noticeOf = (entry: InboxEntry): AgentNotice => ({
  id: entry.eventId,
  at: entry.at,
  kind: entry.type,
  title: `${sentence(entry.type)}: ${entry.entity.id}`,
  ref: `${entry.entity.kind}:${entry.entity.id}`,
});
