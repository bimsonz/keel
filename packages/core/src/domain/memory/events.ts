import { Schema } from "effect";
import {
  AgentId,
  ChangeId,
  ConflictId,
  DecisionId,
  EscalationId,
  GuardId,
  SessionId,
  SubjectId,
  TenetId,
} from "../kernel/index.ts";
import { Predicate } from "../coordination/index.ts";
import { Sponsor } from "../identity/index.ts";

export const RulingGiven = Schema.TaggedStruct("RulingGiven", {
  escalationId: EscalationId,
  /** The id of the option chosen, one of the escalation's. */
  option: Schema.NonEmptyString,
  by: Schema.String,
  rationale: Schema.optional(Schema.String),
});
/** A ruling recorded: the option chosen, the alternatives it rejected (every other option), and the evidence. */
export const DecisionRecorded = Schema.TaggedStruct("DecisionRecorded", {
  decisionId: DecisionId,
  escalationId: EscalationId,
  /** The id of the option the ruling chose. */
  option: Schema.NonEmptyString,
  /** The chosen option's label. */
  summary: Schema.String,
  scope: Schema.optional(Schema.String),
  evidence: Schema.Array(Schema.String),
  alternatives: Schema.Array(
    Schema.Struct({ option: Schema.String, reasonRejected: Schema.String }),
  ),
});
export const DecisionSuperseded = Schema.TaggedStruct("DecisionSuperseded", {
  decisionId: DecisionId,
  by: DecisionId,
});
export const DecisionOverruled = Schema.TaggedStruct("DecisionOverruled", {
  decisionId: DecisionId,
  by: DecisionId,
  requestedBy: ChangeId,
});
export const PrecedentSurfaced = Schema.TaggedStruct("PrecedentSurfaced", {
  decisionId: DecisionId,
  changeId: ChangeId,
});
export const PrecedentFollowed = Schema.TaggedStruct("PrecedentFollowed", {
  decisionId: DecisionId,
  changeId: ChangeId,
});
export const PrecedentDistinguished = Schema.TaggedStruct("PrecedentDistinguished", {
  decisionId: DecisionId,
  changeId: ChangeId,
  distinction: Schema.String,
});
export const OverruleRequested = Schema.TaggedStruct("OverruleRequested", {
  decisionId: DecisionId,
  changeId: ChangeId,
  argument: Schema.String,
});
export const TenetEstablished = Schema.TaggedStruct("TenetEstablished", {
  tenetId: TenetId,
  subjectId: SubjectId,
  predicate: Predicate,
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  changeId: ChangeId,
  /** At least one: a tenet is a landed effect backed by a guard. */
  guardIds: Schema.Array(GuardId).check(Schema.isMinLength(1)),
});
export const TenetContested = Schema.TaggedStruct("TenetContested", {
  tenetId: TenetId,
  conflictId: ConflictId,
});
export const TenetReaffirmed = Schema.TaggedStruct("TenetReaffirmed", {
  tenetId: TenetId,
  conflictId: ConflictId,
});
/**
 * A tenet trunk no longer holds: `changeId` landed against it. `conflictId` is
 * the conflict that contested it. `decisionId` is present when a ruling
 * retracted it; without one, the conflict was proven and the project's policy
 * for the predicate let the change land (advise or annotate).
 */
export const TenetRetracted = Schema.TaggedStruct("TenetRetracted", {
  tenetId: TenetId,
  changeId: ChangeId,
  conflictId: ConflictId,
  decisionId: Schema.optional(DecisionId),
});
export const TenetSuperseded = Schema.TaggedStruct("TenetSuperseded", {
  tenetId: TenetId,
  by: TenetId,
});
export const SessionOpened = Schema.TaggedStruct("SessionOpened", {
  sessionId: SessionId,
  agentId: AgentId,
  harness: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  /** The human the agent acts for in this session, when it has a sponsor. */
  onBehalfOf: Schema.optional(Sponsor),
});
export const MessagesCaptured = Schema.TaggedStruct("MessagesCaptured", {
  sessionId: SessionId,
  fromSeq: Schema.Int,
  toSeq: Schema.Int,
  bundleRef: Schema.String,
});
export const SessionRedacted = Schema.TaggedStruct("SessionRedacted", {
  sessionId: SessionId,
  ranges: Schema.Array(Schema.Struct({ fromSeq: Schema.Int, toSeq: Schema.Int })),
  reason: Schema.String,
});

export const MemoryEvent = Schema.Union([
  RulingGiven,
  DecisionRecorded,
  DecisionSuperseded,
  DecisionOverruled,
  PrecedentSurfaced,
  PrecedentFollowed,
  PrecedentDistinguished,
  OverruleRequested,
  TenetEstablished,
  TenetContested,
  TenetReaffirmed,
  TenetRetracted,
  TenetSuperseded,
  SessionOpened,
  MessagesCaptured,
  SessionRedacted,
]);
export type MemoryEvent = typeof MemoryEvent.Type;
