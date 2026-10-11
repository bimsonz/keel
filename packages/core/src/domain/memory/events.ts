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

export const RulingGiven = Schema.TaggedStruct("RulingGiven", {
  escalationId: EscalationId,
  option: Schema.String,
  by: Schema.String,
  rationale: Schema.optional(Schema.String),
});
export const DecisionRecorded = Schema.TaggedStruct("DecisionRecorded", {
  decisionId: DecisionId,
  escalationId: EscalationId,
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
  guardIds: Schema.Array(GuardId),
});
export const TenetContested = Schema.TaggedStruct("TenetContested", {
  tenetId: TenetId,
  conflictId: ConflictId,
});
export const TenetReaffirmed = Schema.TaggedStruct("TenetReaffirmed", {
  tenetId: TenetId,
  conflictId: ConflictId,
});
export const TenetRetracted = Schema.TaggedStruct("TenetRetracted", {
  tenetId: TenetId,
  changeId: ChangeId,
  decisionId: DecisionId,
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
