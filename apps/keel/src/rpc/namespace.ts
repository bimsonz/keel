import { IdempotencyConflict } from "@keeltown/core/domain/identity";
import {
  Escalation,
  EscalationCategory,
  EscalationEvidence,
  EscalationNotFound,
  EscalationOption,
  EscalationStateRefused,
  InvalidEscalation,
  RulingOptionUnknown,
} from "@keeltown/core/domain/verification";
import {
  DecisionId,
  EntityRef,
  EscalationId,
  OrgId,
  ProjectId,
  UserId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** An escalation with where it belongs and the decision its ruling recorded (the port's `EscalationRecord`). */
export const EscalationRecord = Schema.Struct({
  escalation: Escalation,
  namespace: OrgId,
  project: ProjectId,
  sponsor: Schema.optional(UserId),
  decisionId: Schema.optional(DecisionId),
});

/**
 * A question for a person (core's `RaiseRequest`, without its namespace: the
 * object's own address says whose it is). The id is the caller's, derived
 * from what the question is about.
 */
export const RaiseCommand = Schema.Struct({
  escalationId: EscalationId,
  project: ProjectId,
  sponsor: Schema.optional(UserId),
  raisedBy: Schema.String,
  ask: Schema.Struct({
    question: Schema.String,
    options: Schema.Array(EscalationOption),
    about: EntityRef,
    category: EscalationCategory,
    evidence: Schema.Array(EscalationEvidence),
    precedents: Schema.Array(DecisionId),
    default: Schema.String,
  }),
});

/** A person's answer (core's `RulingCommand`). */
export const RuleCommand = Schema.Struct({
  escalationId: EscalationId,
  option: Schema.String,
  by: UserId,
  rationale: Schema.optional(Schema.String),
  idempotencyKey: Schema.String,
});

export const NamespaceCodecs = {
  raise: exitCodec(EscalationRecord, InvalidEscalation),
  rule: exitCodec(
    EscalationRecord,
    Schema.Union([
      EscalationNotFound,
      EscalationStateRefused,
      RulingOptionUnknown,
      IdempotencyConflict,
    ]),
  ),
  escalation: exitCodec(EscalationRecord, EscalationNotFound),
};

/**
 * A namespace's object (`ns:<id>`): what belongs to whoever owns a project,
 * be it a person, an agent or an org. It hosts the escalations of the
 * namespace's projects and the decisions their rulings record.
 */
export interface NamespaceRpc extends EventReceiverRpc {
  /** Raises an escalation once: the same id again answers it as first raised. */
  raise(command: typeof RaiseCommand.Encoded): Promise<ExitJson>;
  /** A person's ruling, with the decision it records. Once per escalation, idempotent by key. */
  rule(command: typeof RuleCommand.Encoded): Promise<ExitJson>;
  /** An escalation of this namespace as it stands. */
  escalation(escalationId: string): Promise<ExitJson>;
}
