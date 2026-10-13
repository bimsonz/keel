import {
  approveSponsor,
  askSponsor,
  changeStanding,
  endSponsorship,
  enrol,
  hearEvent,
  INBOX_PAGE,
  openSession,
  readInbox,
  reserveChange,
  type StandingMove,
  takeNotices,
  viewSession,
} from "@keeltown/core/application/identity";
import { AgentId, type EventEnvelope } from "@keeltown/core/kernel";
import type { Transaction } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import {
  AgentSessionCodecs,
  type AgentSessionRpc,
  ApproveSponsorCommand,
  AskSponsorCommand,
  EndSponsorCommand,
  EnrolCommand,
  InboxRead,
  OpenSession,
  ReserveChange,
  StandingCommand,
  TakeNotices,
} from "../../../rpc/index.ts";
import { type AgentSessionServices, agentSessionServices } from "../../../composition/do.ts";
import { isInboxCursor, socketFrame } from "../notices.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The AgentSession DO is named `agent:<agentId>`. */
const agentIdOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(AgentId)(name?.replace(/^agent:/, ""));

/** The inbox cursor a socket has been sent up to, kept on the socket so it survives hibernation. */
function cursorOf(socket: WebSocket): string | undefined {
  const attached: unknown = socket.deserializeAttachment();
  return typeof attached === "object" &&
    attached !== null &&
    "cursor" in attached &&
    typeof attached.cursor === "string"
    ? attached.cursor
    : undefined;
}

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

  /** The agent's snapshot, computed from its rows. Declaration fidelity stays null until Keel derives effects. */
  async describe() {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = viewSession(agentId).pipe(
      Effect.map((view) => ({ agentId, ...view, fidelity: null })),
    );
    return this.answer(AgentSessionCodecs.describe, program);
  }

  async openSession(command: typeof OpenSession.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(OpenSession)(command).pipe(
      Effect.orDie,
      Effect.flatMap((opening) => openSession(agentId, opening)),
    );
    return this.answer(AgentSessionCodecs.openSession, program);
  }

  /**
   * Every event delivered to the agent joins its inbox, except one it caused
   * itself, and moves the leases it holds (`hearEvent`). `answer` then wakes
   * any inbox waiting on it.
   */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    const agentId = agentIdOf(this.ctx.id.name);
    hearEvent(tx.store, agentId, event);
    return { entity: { kind: "agent", id: agentId }, drafts: [] };
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

  /**
   * The agent's WebSocket, a projection of its inbox. The isolate has already
   * authenticated the upgrade (`agent:read`) and forwards it only to the
   * caller's own object. The socket is accepted for hibernation and sent its
   * snapshot (every notice after `?cursor`) in the same turn, so nothing
   * committed in between is missed; later notices follow each committed
   * delivery. A client reconciles by reconnecting with the last frame's cursor.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
    if (cursor !== undefined && !isInboxCursor(cursor))
      return new Response("cursor is not an inbox cursor.", { status: 400 });
    const { 0: client, 1: socket } = new WebSocketPair();
    this.ctx.acceptWebSocket(socket);
    socket.serializeAttachment({ cursor });
    this.project(socket, "snapshot");
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Once a delivery is durable, each socket is sent what it has not seen. Never sooner: `send` is outside the output gate. */
  protected override async received(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    await this.ctx.storage.sync();
    for (const socket of sockets) {
      try {
        this.project(socket, "notices");
      } catch (error) {
        // A socket closing under us loses nothing: its client reconnects from its last cursor.
        console.warn("inbox socket push failed", error);
      }
    }
  }

  /** Clients only listen; a reconnect with `?cursor` is how they reconcile. */
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed, or a code (1005, 1006) that cannot be sent back.
    }
  }

  /**
   * Sends the socket every notice after its cursor, a page a frame, and keeps
   * the cursor it reached on the socket. Synchronous, so a snapshot shares the
   * turn that accepted the socket. Reading marks the notices read, as an inbox
   * read does: none of them then rides a tool result.
   */
  private project(socket: WebSocket, first: "snapshot" | "notices"): void {
    let type = first;
    for (;;) {
      const page = this.runtime.runSync(readInbox(cursorOf(socket)));
      if (type === "snapshot" || page.notices.length > 0) socket.send(socketFrame(type, page));
      socket.serializeAttachment({ cursor: page.cursor });
      if (page.notices.length < INBOX_PAGE) return;
      type = "notices";
    }
  }

  /** The piggyback: up to 3 notices for the agent's next tool result, each taken once. */
  async takeNotices(request: typeof TakeNotices.Encoded) {
    const program = Schema.decodeUnknownEffect(TakeNotices)(request).pipe(
      Effect.orDie,
      Effect.flatMap(({ limit }) => takeNotices(limit)),
    );
    return this.answer(AgentSessionCodecs.takeNotices, program);
  }

  /** Enrols this object's agent: AgentEnrolled committed, then the directory row written, before it answers. */
  async suspend(command: typeof StandingCommand.Encoded) {
    return this.standing("suspend", command);
  }

  async reinstate(command: typeof StandingCommand.Encoded) {
    return this.standing("reinstate", command);
  }

  async revoke(command: typeof StandingCommand.Encoded) {
    return this.standing("revoke", command);
  }

  private standing(move: StandingMove, command: typeof StandingCommand.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(StandingCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((moving) => changeStanding(agentId, move, moving)),
    );
    return this.answer(AgentSessionCodecs[move], program);
  }

  async askSponsor(command: typeof AskSponsorCommand.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(AskSponsorCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((asking) => askSponsor(agentId, asking.codeHash)),
    );
    return this.answer(AgentSessionCodecs.askSponsor, program);
  }

  /** The agent is told in its own inbox, so an open socket is sent the notice once the commit is durable. */
  async approveSponsor(command: typeof ApproveSponsorCommand.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(ApproveSponsorCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((approving) => approveSponsor(agentId, approving)),
    );
    const answer = await this.answer(AgentSessionCodecs.approveSponsor, program);
    await this.received();
    return answer;
  }

  async endSponsorship(command: typeof EndSponsorCommand.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(EndSponsorCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((ending) => endSponsorship(agentId, ending)),
    );
    const answer = await this.answer(AgentSessionCodecs.endSponsorship, program);
    await this.received();
    return answer;
  }

  async enrol(command: typeof EnrolCommand.Encoded) {
    const agentId = agentIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(EnrolCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((enrolling) => enrol(agentId, enrolling)),
    );
    return this.answer(AgentSessionCodecs.enrol, program);
  }
}
