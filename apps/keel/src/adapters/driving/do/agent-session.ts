import { AgentNotKnown } from "@keeltown/core/domain/identity";
import { NotImplemented } from "@keeltown/core/not-implemented";
import { AgentId, type EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore, type Transaction } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { AgentSessionCodecs, type AgentSessionRpc, type InboxRead, type OpenSession, type ReserveChange, SessionSnapshot } from "../../../rpc/index.ts";
import { KeelObject, type Reaction } from "./keel-object.ts";

/** The AgentSession DO is named `agent:<agentId>`. */
const agentIdOf = (name: string | undefined) => Schema.decodeUnknownSync(AgentId)(name?.replace(/^agent:/, ""));

/** Where the snapshot of this agent's session state lives in the DO's EntityStore. */
export const SNAPSHOT = { kind: "agent-session", id: "self" } as const;

/** The agent's inbox: one row per event delivered to it, in arrival order. B1.2 turns these into notices. */
export const INBOX = { kind: "inbox", head: { kind: "inbox-head", id: "self" } } as const;

/** Inbox positions sort as strings. */
const position = (n: number) => String(n).padStart(12, "0");

/**
 * The AgentSession DO (`agent:<id>`): inbox, cursor, leases, fidelity and the
 * agent's live connections. Every RPC answers with an Exit envelope.
 */
export class AgentSessionDO extends KeelObject implements AgentSessionRpc {
  async describe() {
    const name = this.ctx.id.name;
    const program = Effect.gen(function* () {
      const agentId = agentIdOf(name);
      const store = yield* EntityStore;
      const stored = store.get(SNAPSHOT.kind, SNAPSHOT.id);
      if (stored === undefined) return yield* new AgentNotKnown({ agentId });
      // A stored snapshot that no longer decodes is a defect: it crosses as `Die`.
      return Schema.decodeUnknownSync(SessionSnapshot)(stored);
    });
    return this.answer(AgentSessionCodecs.describe, program);
  }

  async openSession(_details: typeof OpenSession.Encoded) {
    return this.answer(AgentSessionCodecs.openSession, Effect.die(new NotImplemented("identity/openSession")));
  }

  /** Every event delivered to the agent joins its inbox. */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    const head = tx.store.get(INBOX.head.kind, INBOX.head.id);
    const next = (typeof head === "number" ? head : 0) + 1;
    tx.store.put(INBOX.kind, position(next), { eventId: event.eventId, type: event.type, entity: event.entity, seq: event.seq, at: event.at });
    tx.store.put(INBOX.head.kind, INBOX.head.id, next);
    return { entity: { kind: "agent", id: agentIdOf(this.ctx.id.name) }, drafts: [] };
  }

  // Keel implements these two; until then they cross as a NotImplemented defect.
  async reserveChange(_request: typeof ReserveChange.Encoded) {
    return this.answer(AgentSessionCodecs.reserveChange, Effect.die(new NotImplemented("identity/reserveChange")));
  }

  async inbox(_request: typeof InboxRead.Encoded) {
    return this.answer(AgentSessionCodecs.inbox, Effect.die(new NotImplemented("identity/inbox")));
  }
}
