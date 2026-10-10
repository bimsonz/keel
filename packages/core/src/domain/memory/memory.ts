import { Schema } from "effect";
import { AgentId, DecisionId, EscalationId, GuardId, InstantSchema, SessionId, SubjectId, TenetId } from "../kernel/index.ts";
import { Predicate, Relation } from "../coordination/index.ts";

export const DecisionState = Schema.Literals(["active", "superseded", "overruled"]);
export type DecisionState = typeof DecisionState.Type;

/** A recorded ruling, with its date, scope, evidence and the alternatives it rejected. */
export const Decision = Schema.Struct({
  id: DecisionId,
  escalationId: EscalationId,
  summary: Schema.String,
  scope: Schema.optional(Schema.String),
  evidence: Schema.Array(Schema.String),
  alternatives: Schema.Array(Schema.Struct({ option: Schema.String, reasonRejected: Schema.String })),
  decidedAt: InstantSchema,
  state: DecisionState,
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
  value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  guards: Schema.NonEmptyArray(GuardId),
  state: TenetState,
});
export type Tenet = typeof Tenet.Type;

export const EscalationState = Schema.Literals(["open", "ruled", "withdrawn"]);
export type EscalationState = typeof EscalationState.Type;

export const Session = Schema.Struct({
  id: SessionId,
  agentId: AgentId,
  harness: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  openedAt: InstantSchema,
});
export type Session = typeof Session.Type;

/** One link in a `why` chain: a summary and the MFP record id behind it. */
export const WhyLink = Schema.Struct({ summary: Schema.String, recordId: Schema.String });
export type WhyLink = typeof WhyLink.Type;
