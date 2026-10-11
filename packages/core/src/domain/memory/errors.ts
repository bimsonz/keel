import { Schema } from "effect";
import { DecisionId, NextAction, SessionId } from "../kernel/index.ts";
import { DecisionState } from "./memory.ts";

export class DecisionNotFound extends Schema.TaggedError<DecisionNotFound>()("DecisionNotFound", {
  decisionId: DecisionId,
}) {}

/** The decision's state, or the ruling it needs, does not take the command. `nextActions` is never empty. */
export class DecisionStateRefused extends Schema.TaggedError<DecisionStateRefused>()(
  "DecisionStateRefused",
  {
    decisionId: DecisionId,
    state: Schema.optional(DecisionState),
    command: Schema.String,
    reason: Schema.optional(Schema.String),
    nextActions: Schema.Array(NextAction),
  },
) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  sessionId: SessionId,
}) {}

/** Nothing explains the path, line or subject asked about. */
export class NothingToExplain extends Schema.TaggedError<NothingToExplain>()("NothingToExplain", {
  target: Schema.String,
}) {}
