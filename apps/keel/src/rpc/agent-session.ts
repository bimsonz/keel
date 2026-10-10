import { AgentNotKnown, AgentNotAdmitted } from "@keeltown/core/domain/identity";
import { AgentId, InstantSchema, SessionId } from "@keeltown/core/kernel";
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

export const AgentSessionCodecs = {
  describe: exitCodec(SessionSnapshot, AgentNotKnown),
  openSession: exitCodec(Schema.Struct({ id: SessionId, openedAt: InstantSchema }), Schema.Union([AgentNotKnown, AgentNotAdmitted])),
};

/** The AgentSession DO: inbox, cursor, leases, fidelity and the agent's live connections. */
export interface AgentSessionRpc {
  describe(): Promise<ExitJson>;
  openSession(details: typeof OpenSession.Encoded): Promise<ExitJson>;
}
