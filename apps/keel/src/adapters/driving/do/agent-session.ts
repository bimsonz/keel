import { DurableObject } from "cloudflare:workers";
import { AgentNotKnown } from "@keeltown/core/domain/identity";
import { NotImplemented } from "@keeltown/core/not-implemented";
import { AgentId } from "@keeltown/core/kernel";
import { EntityStore } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { durableObjectRuntime, type DurableObjectRuntime } from "../../../composition/do.ts";
import { AgentSessionCodecs, type AgentSessionRpc, encodeExit, type InboxRead, type OpenSession, type ReserveChange, SessionSnapshot } from "../../../rpc/index.ts";

/** The AgentSession DO is named `agent:<agentId>`. */
const agentIdOf = (name: string | undefined) => Schema.decodeUnknownSync(AgentId)(name?.replace(/^agent:/, ""));

/** Where the snapshot of this agent's session state lives in the DO's EntityStore. */
export const SNAPSHOT = { kind: "agent-session", id: "self" } as const;

/**
 * The AgentSession DO (`agent:<id>`): inbox, cursor, leases, fidelity and the
 * agent's live connections. Every RPC answers with an Exit envelope.
 */
export class AgentSessionDO extends DurableObject<Env> implements AgentSessionRpc {
  private readonly runtime: DurableObjectRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = durableObjectRuntime(ctx);
  }

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
    return encodeExit(AgentSessionCodecs.describe, await this.runtime.runPromiseExit(program));
  }

  async openSession(_details: typeof OpenSession.Encoded) {
    return encodeExit(AgentSessionCodecs.openSession, await this.runtime.runPromiseExit(Effect.die(new NotImplemented("identity/openSession"))));
  }

  // Keel implements these two; until then they cross as a NotImplemented defect.
  async reserveChange(_request: typeof ReserveChange.Encoded) {
    return encodeExit(AgentSessionCodecs.reserveChange, await this.runtime.runPromiseExit(Effect.die(new NotImplemented("identity/reserveChange"))));
  }

  async inbox(_request: typeof InboxRead.Encoded) {
    return encodeExit(AgentSessionCodecs.inbox, await this.runtime.runPromiseExit(Effect.die(new NotImplemented("identity/inbox"))));
  }
}
