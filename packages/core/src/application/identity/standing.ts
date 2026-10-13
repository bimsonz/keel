import { Effect, Result, Schema } from "effect";
import {
  Agent,
  AgentEvent,
  type AgentNotKnown,
  AgentReinstated,
  AgentRevoked,
  AgentSponsored,
  type AgentStateRefused,
  AgentSuspended,
  AgentUnsponsored,
  decideAgent,
  evolveAgent,
  IdempotencyConflict,
} from "../../domain/identity/index.ts";
import {
  type CommandActor as EventActor,
  AgentId,
  type EventEnvelope,
  UserId,
} from "../../domain/kernel/index.ts";
import {
  AgentDirectory,
  type AgentStanding,
  type Clock,
  commit,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  type Stored,
} from "../ports/index.ts";
import { AGENT } from "./enrol.ts";

/** The moves on an agent's standing. */
export type StandingMove = "suspend" | "reinstate" | "revoke";

/**
 * The agent as its own AgentSession DO answers a move on its standing or its
 * sponsor link: without a namespace. The object's row keeps the namespace the
 * agent was enrolled into and is never told of a later one, so the directory
 * is the one place a namespace is read from.
 */
export const withoutNamespace = (agent: Agent): Agent => {
  const { org: _kept, ...answered } = agent;
  return answered;
};

/** A suspension, reinstatement or revocation, as the isolate sends it. */
export interface StandingChange {
  /** Who moves it, as the envelope names an actor (`user:<id>`): the events' `by` and the commit's actor. */
  readonly by: EventActor;
  /** Why the agent is suspended; a suspension needs one, the others take none. */
  readonly reason?: string | undefined;
  readonly idempotencyKey: string;
  /** A hash of the request, so a reused key is told apart from a retry. */
  readonly fingerprint: string;
}

const decodeAgent = Schema.decodeUnknownSync(Agent);
const encodeAgent = Schema.encodeSync(Agent);
const encodeEvent = Schema.encodeSync(AgentEvent);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const decodeSuspended = Schema.decodeUnknownOption(AgentSuspended);
const decodeReinstated = Schema.decodeUnknownOption(AgentReinstated);
const decodeRevoked = Schema.decodeUnknownOption(AgentRevoked);
const decodeSponsored = Schema.decodeUnknownOption(AgentSponsored);
const decodeUnsponsored = Schema.decodeUnknownOption(AgentUnsponsored);

/** The events that move an agent's standing. */
export const STANDING_EVENTS = ["AgentSuspended", "AgentReinstated", "AgentRevoked"] as const;

/**
 * The standing an agent's event leaves it in, with the agent and the event's
 * seq on the agent's entity: what the directory's guarded write takes. None
 * for any other event. A suspension and a reinstatement leave the epoch as it
 * was; only a revocation moves it.
 */
export function standingOf(
  event: EventEnvelope,
):
  | { readonly agentId: AgentId; readonly standing: AgentStanding; readonly seq: number }
  | undefined {
  if (event.entity.kind !== "agent") return undefined;
  const seq = event.seq;
  switch (event.type) {
    case "AgentSuspended": {
      const suspended = decodeSuspended(event.payload);
      return suspended._tag === "Some"
        ? { agentId: suspended.value.agentId, standing: { state: "suspended" }, seq }
        : undefined;
    }
    case "AgentReinstated": {
      const reinstated = decodeReinstated(event.payload);
      return reinstated._tag === "Some"
        ? { agentId: reinstated.value.agentId, standing: { state: "active" }, seq }
        : undefined;
    }
    case "AgentRevoked": {
      const revoked = decodeRevoked(event.payload);
      return revoked._tag === "Some"
        ? {
            agentId: revoked.value.agentId,
            standing: { state: "revoked", revocationEpoch: revoked.value.revocationEpoch },
            seq,
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Who sponsors an agent as one of its events leaves it (`null`: nobody), with
 * the agent and the event's seq: what the directory's guarded write takes.
 * None for any other event.
 */
export function sponsorOf(
  event: EventEnvelope,
):
  | { readonly agentId: AgentId; readonly sponsor: UserId | null; readonly seq: number }
  | undefined {
  if (event.entity.kind !== "agent") return undefined;
  const seq = event.seq;
  switch (event.type) {
    case "AgentSponsored": {
      const sponsored = decodeSponsored(event.payload);
      return sponsored._tag === "Some"
        ? { agentId: sponsored.value.agentId, sponsor: sponsored.value.sponsor, seq }
        : undefined;
    }
    case "AgentUnsponsored": {
      const ended = decodeUnsponsored(event.payload);
      return ended._tag === "Some"
        ? { agentId: ended.value.agentId, sponsor: null, seq }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Suspends, reinstates or revokes the agent this AgentSession DO is for,
 * through the domain's Agent machine, idempotent by `standing:<key>`. The
 * directory row is written before answering, guarded by the event's seq, so
 * the agent's next request is judged by its new standing and no later write
 * moves the row back; the Projector repeats the write on delivery, which
 * repairs a crash between the commit and the row. A replay writes again and
 * answers the agent as it stands. The answer names no namespace
 * (`withoutNamespace`).
 */
export const changeStanding: (
  agentId: AgentId,
  move: StandingMove,
  command: StandingChange,
) => Effect.Effect<
  Agent,
  AgentNotKnown | AgentStateRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | AgentDirectory
> = Effect.fn("identity/changeStanding")(function* (
  agentId: AgentId,
  move: StandingMove,
  command: StandingChange,
) {
  const stored = (yield* EntityStore).get(AGENT, agentId);
  const project = stored === undefined ? undefined : decodeAgent(stored).projectId;
  const committed = yield* commit(
    {
      entity: { kind: "agent", id: agentId },
      cause: `standing:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: command.by,
      ...(project === undefined ? {} : { project }),
    },
    (tx) => {
      const current = tx.store.get(AGENT, agentId);
      const state = current === undefined ? undefined : decodeAgent(current);
      const decided = decideAgent(
        state,
        move === "suspend"
          ? { _tag: "Suspend", reason: command.reason ?? "", by: command.by }
          : move === "reinstate"
            ? { _tag: "Reinstate", by: command.by }
            : { _tag: "Revoke", by: command.by },
        { now: tx.at, agentId },
      );
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      let agent = state;
      const drafts: EventDraft[] = [];
      for (const payload of decided.success) {
        agent = evolveAgent(agent, { at: tx.at, payload });
        drafts.push({ payload: JSON.parse(JSON.stringify(encodeEvent(payload))) });
      }
      if (agent === undefined) throw new Error(`${agentId} has no state after ${move}`);
      tx.store.put(AGENT, agentId, asStored(encodeAgent(agent)));
      return Result.succeed({ value: agent, drafts });
    },
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
  const directory = yield* AgentDirectory;
  for (const event of committed.events) {
    const moved = standingOf(event);
    if (moved !== undefined) yield* directory.standing(moved.agentId, moved.standing, moved.seq);
  }
  return withoutNamespace(
    committed.duplicate ? decodeAgent((yield* EntityStore).get(AGENT, agentId)) : committed.value,
  );
});

/**
 * The Projector's repair of the directory: each standing event it receives is
 * noted here in the receipt's transaction (the newest per agent), and written
 * once the transaction is done. The inline write normally got there first,
 * and the seq guard makes the repeat a no-op.
 */
export const STANDING_PENDING = "standing-pending";

const Pending = Schema.Struct({
  state: Schema.Literals(["active", "suspended", "revoked"]),
  revocationEpoch: Schema.optional(Schema.Int),
  seq: Schema.Int,
});
const decodePending = Schema.decodeUnknownSync(Pending);

/** The same repair for who sponsors an agent: the newest link event per agent. */
export const SPONSOR_PENDING = "sponsor-pending";

const PendingSponsor = Schema.Struct({ sponsor: Schema.NullOr(UserId), seq: Schema.Int });
const decodePendingSponsor = Schema.decodeUnknownSync(PendingSponsor);

/**
 * Notes the standing, or the sponsor, an agent's event leaves it with, for
 * `repairStandings`; any other event is ignored.
 */
export function noteStanding(store: (typeof EntityStore)["Service"], event: EventEnvelope): void {
  const linked = sponsorOf(event);
  if (linked !== undefined) {
    const noted = store.get(SPONSOR_PENDING, linked.agentId);
    if (noted === undefined || decodePendingSponsor(noted).seq < linked.seq)
      store.put(
        SPONSOR_PENDING,
        linked.agentId,
        asStored({ sponsor: linked.sponsor, seq: linked.seq }),
      );
  }
  const moved = standingOf(event);
  if (moved === undefined) return;
  const held = store.get(STANDING_PENDING, moved.agentId);
  if (held !== undefined && decodePending(held).seq >= moved.seq) return;
  store.put(
    STANDING_PENDING,
    moved.agentId,
    asStored({
      state: moved.standing.state,
      ...(moved.standing.revocationEpoch === undefined
        ? {}
        : { revocationEpoch: moved.standing.revocationEpoch }),
      seq: moved.seq,
    }),
  );
}

/**
 * Writes every noted standing and sponsor to the directory, and forgets each
 * once written. A write that fails stays noted for the next delivery's repair.
 */
export const repairStandings: Effect.Effect<void, never, EntityStore | AgentDirectory> = Effect.gen(
  function* () {
    const store = yield* EntityStore;
    const directory = yield* AgentDirectory;
    for (const { id, value } of store.list(STANDING_PENDING)) {
      const pending = decodePending(value);
      const written = yield* Effect.exit(
        directory.standing(
          Schema.decodeUnknownSync(AgentId)(id),
          pending.revocationEpoch === undefined
            ? { state: pending.state }
            : { state: pending.state, revocationEpoch: pending.revocationEpoch },
          pending.seq,
        ),
      );
      if (written._tag === "Failure") continue;
      store.transaction(() => {
        const now = store.get(STANDING_PENDING, id);
        if (now !== undefined && decodePending(now).seq === pending.seq)
          store.remove(STANDING_PENDING, id);
      });
    }
    for (const { id, value } of store.list(SPONSOR_PENDING)) {
      const pending = decodePendingSponsor(value);
      const written = yield* Effect.exit(
        directory.sponsor(Schema.decodeUnknownSync(AgentId)(id), pending.sponsor, pending.seq),
      );
      if (written._tag === "Failure") continue;
      store.transaction(() => {
        const now = store.get(SPONSOR_PENDING, id);
        if (now !== undefined && decodePendingSponsor(now).seq === pending.seq)
          store.remove(SPONSOR_PENDING, id);
      });
    }
  },
);
