import { Schema } from "effect";
import { DecisionId, SessionId } from "../kernel/index.ts";

export class DecisionNotFound extends Schema.TaggedError<DecisionNotFound>()("DecisionNotFound", {
  decisionId: DecisionId,
}) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  sessionId: SessionId,
}) {}

/** Nothing explains the path, line or subject asked about. */
export class NothingToExplain extends Schema.TaggedError<NothingToExplain>()("NothingToExplain", {
  target: Schema.String,
}) {}
