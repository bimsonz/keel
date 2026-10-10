import { Schema } from "effect";
import { InstantSchema } from "../kernel/index.ts";

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
