import {
  enrol,
  readInbox,
  recordDelivery,
  reserveChange,
} from "@keeltown/core/application/identity";
import { AgentNotKnown } from "@keeltown/core/domain/identity";
import { NotImplemented } from "@keeltown/core/not-implemented";
import { AgentId, type EventEnvelope } from "@keeltown/core/kernel";
import { EntityStore, type Transaction } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import {
  AgentSessionCodecs,
  type AgentSessionRpc,
  EnrolCommand,
  InboxRead,
  type OpenSession,
  ReserveChange,
  SessionSnapshot,
} from "../../../rpc/index.ts";
import { type AgentSessionServices, agentSessionServices } from "../../../composition/do.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The AgentSession DO is named `agent:<agentId>`. */
const agentIdOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(AgentId)(name?.replace(/^agent:/, ""));

/** Where the snapshot of this agent's session state lives in the DO's EntityStore. */
export const SNAPSHOT = { kind: "agent-session", id: "self" } as const;

/**
 * The AgentSession DO (`agent:<id>`): inbox, cursor, leases, fidelity and the
 * agent's live connections. Every RPC answers with an Exit envelope.
 */
export class AgentSessionDO
  extends KeelObjectWith<AgentSessionServices>
  implements AgentSessionRpc
{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, agentSessionServices(env));
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
    return this.answer(AgentSessionCodecs.describe, program);
  }

  async openSession(_details: typeof OpenSession.Encoded) {
    return this.answer(
      AgentSessionCodecs.openSession,
      Effect.die(new NotImplemented("identity/openSession")),
    );
  }

  /** Every event delivered to the agent joins its inbox; `answer` then wakes any inbox waiting on it. */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    recordDelivery(tx.store, event);
    return { entity: { kind: "agent", id: agentIdOf(this.ctx.id.name) }, drafts: [] };
  }

  async reserveChange(request: typeof ReserveChange.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(ReserveChange)(request).pipe(
      Effect.orDie,
      Effect.flatMap((decoded) => reserveChange(agentId, decoded)),
    );
    return this.answer(AgentSessionCodecs.reserveChange, program);
  }

  /** The notices after `cursor`; with `waitMs` above 0 and none yet, the first page a commit brings, or an empty one at the deadline. */
  async inbox(request: typeof InboxRead.Encoded) {
    const waiters = this.waiters;
    const program = Schema.decodeUnknownEffect(InboxRead)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ cursor, waitMs }) =>
        waiters.until(waitMs, readInbox(cursor), (page) => page.notices.length > 0),
      ),
    );
    return this.answer(AgentSessionCodecs.inbox, program);
  }

  /** Enrols this object's agent: AgentEnrolled committed, then the directory row written, before it answers. */
  async enrol(command: typeof EnrolCommand.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(EnrolCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((enrolling) => enrol(agentId, enrolling)),
    );
    return this.answer(AgentSessionCodecs.enrol, program);
  }
}
