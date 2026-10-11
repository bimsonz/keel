import { Schema } from "effect";
import { DecisionId, NextAction, SessionId, TenetId } from "../kernel/index.ts";
import { DecisionState, TenetState } from "./memory.ts";

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

/** The tenet's state, or the conflict, ruling or policy it needs, does not take the command. `nextActions` is never empty. */
export class TenetStateRefused extends Schema.TaggedError<TenetStateRefused>()(
  "TenetStateRefused",
  {
    tenetId: TenetId,
    state: Schema.optional(TenetState),
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
