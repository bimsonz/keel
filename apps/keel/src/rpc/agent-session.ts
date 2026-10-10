import { AgentNotAdmitted, AgentNotKnown, IdempotencyConflict, InboxPage } from "@keeltown/core/domain/identity";
import { AgentId, ChangeId, InstantSchema, SessionId } from "@keeltown/core/kernel";
import { Schema } from "effect";
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

export const OpenSession = Schema.Struct({ harness: Schema.optional(Schema.String), model: Schema.optional(Schema.String) });

/** Reserve a change id for a declare's Idempotency-Key. `fingerprint` hashes the request body. */
export const ReserveChange = Schema.Struct({ idempotencyKey: Schema.String, fingerprint: Schema.String });

export const InboxRead = Schema.Struct({ cursor: Schema.optional(Schema.String), waitMs: Schema.Int });

export const AgentSessionCodecs = {
  describe: exitCodec(SessionSnapshot, AgentNotKnown),
  openSession: exitCodec(Schema.Struct({ id: SessionId, openedAt: InstantSchema }), Schema.Union([AgentNotKnown, AgentNotAdmitted])),
  reserveChange: exitCodec(ChangeId, IdempotencyConflict),
  inbox: exitCodec(InboxPage, AgentNotKnown),
};

/** The AgentSession DO: inbox, cursor, leases, fidelity and the agent's live connections. */
export interface AgentSessionRpc {
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
}
