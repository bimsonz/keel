import {
  Agent,
  AgentKind,
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
  InboxPage,
  Scope,
} from "@keeltown/core/domain/identity";
import { AgentId, ChangeId, InstantSchema, ProjectId, SessionId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** What the AgentSession DO (`agent:<id>`) knows about its agent right now. */
export const SessionSnapshot = Schema.Struct({
  agentId: AgentId,
  session: Schema.NullOr(Schema.Struct({ id: SessionId, openedAt: InstantSchema })),
  inboxDepth: Schema.Int,
  openLeases: Schema.Int,
  /** The share of the agent's derived effects it had declared. Routes review; never judges. */
  fidelity: Schema.NullOr(Schema.Number),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;

export const OpenSession = Schema.Struct({
  harness: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});

/** Reserve a change id for a declare's Idempotency-Key. `fingerprint` hashes the request body. */
export const ReserveChange = Schema.Struct({
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

export const InboxRead = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  waitMs: Schema.Int,
});

/**
 * Enrol the agent this DO is named for. The isolate derives the agent id from
 * the operator and the Idempotency-Key and mints the client secret, sending only
 * its hash. The DO commits AgentEnrolled and writes the D1 projection before it
 * answers, so the credential exchanges for a token at once. A replay with the
 * same key and body re-issues the credential: it replaces `secretHash`, because
 * the first answer (the only place the secret was shown) was lost. Another body
 * under the same key is an IdempotencyConflict.
 */
export const EnrolCommand = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  kind: AgentKind,
  scopes: Schema.Array(Scope),
  clientId: Schema.NonEmptyString,
  /** `sha256:` and the hex digest of the client secret. */
  secretHash: Schema.String,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

export const AgentSessionCodecs = {
  describe: exitCodec(SessionSnapshot, AgentNotKnown),
  openSession: exitCodec(
    Schema.Struct({ id: SessionId, openedAt: InstantSchema }),
    Schema.Union([AgentNotKnown, AgentNotAdmitted]),
  ),
  reserveChange: exitCodec(ChangeId, IdempotencyConflict),
  inbox: exitCodec(InboxPage, AgentNotKnown),
  enrol: exitCodec(Agent, IdempotencyConflict),
};

/** The AgentSession DO: inbox, cursor, leases, fidelity and the agent's live connections. */
export interface AgentSessionRpc extends EventReceiverRpc {
  describe(): Promise<ExitJson>;
  openSession(details: typeof OpenSession.Encoded): Promise<ExitJson>;
  /**
   * The change id for this Idempotency-Key: minted on first use and kept for
   * 24 h, so a retried declare reaches the same change. The same key with a
   * different fingerprint is an IdempotencyConflict.
   */
  reserveChange(request: typeof ReserveChange.Encoded): Promise<ExitJson>;
  /** Notices after `cursor`; with `waitMs` > 0, waits for the next one (an in-DO waiter with a deadline). */
  inbox(request: typeof InboxRead.Encoded): Promise<ExitJson>;
  enrol(command: typeof EnrolCommand.Encoded): Promise<ExitJson>;
}
