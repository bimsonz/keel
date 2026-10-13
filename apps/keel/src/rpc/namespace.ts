import {
  CredentialLabel,
  CredentialMeta,
  CredentialMissing,
  DeployProvider,
} from "@keeltown/core/domain/delivery";
import {
  IdempotencyConflict,
  Invitation,
  InvitationRefused,
  InvitationScopes,
} from "@keeltown/core/domain/identity";
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
  CommandActor,
  AgentId,
  CredentialId,
  DecisionId,
  EntityRef,
  EscalationId,
  NamespaceId,
  ProjectId,
  RunRef,
  UserId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** An escalation with where it belongs and the decision its ruling recorded (the port's `EscalationRecord`). */
export const EscalationRecord = Schema.Struct({
  escalation: Escalation,
  namespace: NamespaceId,
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
  agent: Schema.optional(AgentId),
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

/**
 * A member invites an agent into the namespace (core's `InviteAgent`). The
 * commit's cause is `invite:<agentId>:<idempotencyKey>`.
 */
export const InviteAgentCommand = Schema.Struct({
  agentId: AgentId,
  by: UserId,
  scopes: InvitationScopes,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/** The agent accepts (core's `AcceptInvitation`): `run` is the run it answers in, from its token. */
export const AcceptInvitationCommand = Schema.Struct({
  agentId: AgentId,
  run: Schema.optional(RunRef),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/**
 * An invitation ends (core's `EndInvitation`): `by` is the agent itself or a
 * person, the event's `by` and the commit's actor, and `run` the run an agent
 * ends it in.
 */
export const EndInvitationCommand = Schema.Struct({
  agentId: AgentId,
  by: CommandActor,
  run: Schema.optional(RunRef),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/**
 * A credential's secret as it crosses to the namespace's object and is kept
 * there: sealed in the Worker before it is sent, under a data key of its own
 * that the key `kek` wraps, all base64. The object never opens it.
 */
export const SealedSecret = Schema.Struct({
  v: Schema.Literal(1),
  kek: Schema.String,
  wrapped: Schema.String,
  iv: Schema.String,
  ct: Schema.String,
});

/** A credential to keep (core's `HoldCredential`): the id the Worker minted and sealed the secret under, and the seal. */
export const PutCredentialCommand = Schema.Struct({
  id: CredentialId,
  label: CredentialLabel,
  provider: DeployProvider,
  by: UserId,
  sealed: SealedSecret,
});

/** A credential to remove, and who removes it. */
export const RemoveCredentialCommand = Schema.Struct({ id: CredentialId, by: UserId });

/** One credential with its seal, for the Worker that opens it. */
export const SealedCredential = Schema.Struct({ meta: CredentialMeta, sealed: SealedSecret });

const invitationMove = exitCodec(
  Invitation,
  Schema.Union([InvitationRefused, IdempotencyConflict]),
);

export const NamespaceCodecs = {
  inviteAgent: invitationMove,
  acceptInvitation: invitationMove,
  endInvitation: invitationMove,
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
  putCredential: exitCodec(CredentialMeta, Schema.Never),
  listCredentials: exitCodec(Schema.Array(CredentialMeta), Schema.Never),
  getCredential: exitCodec(SealedCredential, CredentialMissing),
  removeCredential: exitCodec(Schema.Void, CredentialMissing),
};

/**
 * A namespace's object (`ns:<id>`): what belongs to whoever owns a project,
 * be it a person, an agent or an org. It hosts the escalations of the
 * namespace's projects and the decisions their rulings record, and holds the
 * agents its members invited into it.
 */
export interface NamespaceRpc extends EventReceiverRpc {
  /** Raises an escalation once: the same id again answers it as first raised. */
  raise(command: typeof RaiseCommand.Encoded): Promise<ExitJson>;
  /** A person's ruling, with the decision it records. Once per escalation, idempotent by key. */
  rule(command: typeof RuleCommand.Encoded): Promise<ExitJson>;
  /** An escalation of this namespace as it stands. */
  escalation(escalationId: string): Promise<ExitJson>;
  /** A member invites an agent into this namespace, idempotent by key. */
  inviteAgent(command: typeof InviteAgentCommand.Encoded): Promise<ExitJson>;
  /** The invited agent accepts. */
  acceptInvitation(command: typeof AcceptInvitationCommand.Encoded): Promise<ExitJson>;
  /** The agent's invitation ends: it declines or leaves, or a person takes it out. */
  endInvitation(command: typeof EndInvitationCommand.Encoded): Promise<ExitJson>;
  /** Keeps a credential sealed in the Worker, and commits `CredentialStored`. Once per id. */
  putCredential(command: typeof PutCredentialCommand.Encoded): Promise<ExitJson>;
  /** The namespace's credentials, oldest first: their records alone, never a seal. */
  listCredentials(): Promise<ExitJson>;
  /** One credential with its seal, for the Worker that opens it. */
  getCredential(credentialId: string): Promise<ExitJson>;
  /** Removes a credential, seal and all, and commits `CredentialRemoved`. */
  removeCredential(command: typeof RemoveCredentialCommand.Encoded): Promise<ExitJson>;
}
