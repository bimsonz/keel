import { Schema } from "effect";
import {
  AgentId,
  ChangeId,
  ConflictId,
  DecisionId,
  EscalationId,
  GuardId,
  InstantSchema,
  RunRef,
  SessionId,
  SubjectId,
  TenetId,
  UserId,
} from "../kernel/index.ts";
import { Predicate, Relation } from "../coordination/index.ts";
import { KeelRecord } from "./mfp.ts";

export const DecisionState = Schema.Literals(["active", "superseded", "overruled"]);
export type DecisionState = typeof DecisionState.Type;

/** A recorded ruling, with its date, scope, evidence and the alternatives it rejected. */
export const Decision = Schema.Struct({
  id: DecisionId,
  escalationId: EscalationId,
  /** The option the ruling chose. */
  option: Schema.NonEmptyString,
  summary: Schema.String,
  scope: Schema.optional(Schema.String),
  evidence: Schema.Array(Schema.String),
  alternatives: Schema.Array(
    Schema.Struct({ option: Schema.String, reasonRejected: Schema.String }),
  ),
  decidedAt: InstantSchema,
  state: DecisionState,
  /** The decision that superseded or overruled it. */
  endedBy: Schema.optional(DecisionId),
});
export type Decision = typeof Decision.Type;

export const Stance = Schema.Literals(["followed", "distinguished", "overrule-requested"]);
export type Stance = typeof Stance.Type;

export const TenetState = Schema.Literals(["established", "contested", "retracted", "superseded"]);
export type TenetState = typeof TenetState.Type;

/** A belief trunk currently holds: a landed effect backed by at least one guard. */
export const Tenet = Schema.Struct({
  id: TenetId,
  subjectId: SubjectId,
  predicate: Predicate,
  /** How the value is held; `is` when absent. */
  relation: Schema.optional(Relation),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  guards: Schema.NonEmptyArray(GuardId),
  state: TenetState,
  /** The conflict contesting it, from `TenetContested` until it is reaffirmed; kept once it is retracted. */
  conflictId: Schema.optional(ConflictId),
  /** What ended it: the landing change that retracted it, or the tenet that superseded it. */
  endedBy: Schema.optional(Schema.Union([ChangeId, TenetId])),
  /** The ruling it was retracted on, when a ruling did it rather than proof. */
  decisionId: Schema.optional(DecisionId),
});
export type Tenet = typeof Tenet.Type;

export const EscalationState = Schema.Literals(["open", "ruled", "withdrawn"]);
export type EscalationState = typeof EscalationState.Type;

export const Session = Schema.Struct({
  id: SessionId,
  agentId: AgentId,
  harness: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  /** The user who sponsors the agent, from its enrolment, when it has one. */
  sponsor: Schema.optional(UserId),
  /** The run of the agent that opened the session, when its token named one: a session is one run's. */
  run: Schema.optional(RunRef),
  openedAt: InstantSchema,
});
export type Session = typeof Session.Type;

/** One link in a `why` chain: a one-line summary and Keel's record of the MFP message behind it. */
export const WhyLink = Schema.Struct({ summary: Schema.String, record: KeelRecord });
export type WhyLink = typeof WhyLink.Type;
