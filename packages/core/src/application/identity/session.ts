import { Effect, Result, Schema } from "effect";
import { ChangeAdopted, ChangeParked, IntentDeclared } from "../../domain/coordination/index.ts";
import {
  Agent,
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
  notifies,
} from "../../domain/identity/index.ts";
import {
  type AgentId,
  agentActor,
  type EventEnvelope,
  type SessionId,
} from "../../domain/kernel/index.ts";
import { Session, SessionOpened } from "../../domain/memory/index.ts";
import {
  type Clock,
  commit,
  EntityStore,
  type EventOutbox,
  Ids,
  type Stored,
} from "../ports/index.ts";
import { AGENT } from "./enrol.ts";
import { inboxDepth, recordDelivery } from "./inbox.ts";

type Store = (typeof EntityStore)["Service"];

/**
 * Where the AgentSession DO keeps its sessions: each one under the
 * Idempotency-Key that opened it, with that request's fingerprint, and the
 * agent's current session.
 */
export const SESSION = {
  opened: "session",
  current: { kind: "agent-session-current", id: "self" },
} as const;

/** One row per change whose lease the agent holds, by change id. */
export const HELD_LEASE = "held-lease";

const Opened = Schema.Struct({ session: Session, fingerprint: Schema.String });
const decodeOpened = Schema.decodeUnknownSync(Opened);
const encodeOpened = Schema.encodeSync(Opened);
const decodeSession = Schema.decodeUnknownSync(Session);
const encodeSession = Schema.encodeSync(Session);
const encodeOpenedEvent = Schema.encodeSync(SessionOpened);
const decodeAgent = Schema.decodeUnknownSync(Agent);

/** An agent's request to open a session, as the isolate sends it. */
export interface OpenSessionCommand {
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly idempotencyKey: string;
  /** A hash of the request body, so a reused key with another body is told apart from a retry. */
  readonly fingerprint: string;
}

/**
 * Opens a session for the agent this AgentSession DO is for: commits
 * SessionOpened on the session's own entity and makes it the agent's current
 * session, replacing any other.
 *
 * The session's sponsor is the agent's, from its enrolment record: never a
 * value the request or its token carries. An unknown agent is AgentNotKnown;
 * a suspended or revoked one is AgentNotAdmitted.
 *
 * The same Idempotency-Key and body answers the session it opened, without
 * committing again; another body is an IdempotencyConflict. The key's row
 * holds the session, because each session is its own entity, so the outbox
 * has no one entity to find the key's prior commit on.
 */
export const openSession: (
  agentId: AgentId,
  command: OpenSessionCommand,
) => Effect.Effect<
  Session,
  AgentNotKnown | AgentNotAdmitted | IdempotencyConflict,
  Clock | Ids | EntityStore | EventOutbox
> = Effect.fn("identity/openSession")(function* (agentId: AgentId, command: OpenSessionCommand) {
  const enrolled = (yield* EntityStore).get(AGENT, agentId);
  if (enrolled === undefined) return yield* new AgentNotKnown({ agentId });
  const sessionId: SessionId = yield* (yield* Ids).next("ses");
  const committed = yield* commit<Session, AgentNotAdmitted | IdempotencyConflict>(
    {
      entity: { kind: "session", id: sessionId },
      cause: `session:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: agentActor(agentId),
      project: decodeAgent(enrolled).projectId,
    },
    (tx) => {
      const prior = tx.store.get(SESSION.opened, command.idempotencyKey);
      if (prior !== undefined) {
        const opened = decodeOpened(prior);
        return opened.fingerprint === command.fingerprint
          ? Result.succeed({ drafts: [], value: opened.session })
          : Result.fail(new IdempotencyConflict({ idempotencyKey: command.idempotencyKey }));
      }
      const agent = decodeAgent(tx.store.get(AGENT, agentId));
      if (agent.state !== "active")
        return Result.fail(new AgentNotAdmitted({ agentId, reason: agent.state }));
      const details = {
        ...(command.harness === undefined ? {} : { harness: command.harness }),
        ...(command.model === undefined ? {} : { model: command.model }),
        ...(agent.sponsor === undefined ? {} : { sponsor: agent.sponsor }),
      };
      const session: Session = { id: sessionId, agentId, ...details, openedAt: tx.at };
      tx.store.put(
        SESSION.opened,
        command.idempotencyKey,
        asStored(encodeOpened({ session, fingerprint: command.fingerprint })),
      );
      tx.store.put(SESSION.current.kind, SESSION.current.id, asStored(encodeSession(session)));
      const payload = SessionOpened.make({ sessionId, agentId, ...details });
      return Result.succeed({
        drafts: [{ payload: JSON.parse(JSON.stringify(encodeOpenedEvent(payload))) }],
        value: session,
      });
    },
  );
  // Each attempt mints a new session entity, so its cause is never already committed.
  if (committed.duplicate) return yield* Effect.die("a session's entity committed twice");
  return committed.value;
});

/** The agent's current session, or null when it has opened none. */
export function currentSession(store: Store): Session | null {
  const stored = store.get(SESSION.current.kind, SESSION.current.id);
  return stored === undefined ? null : decodeSession(stored);
}

/**
 * Keeps one row per change whose lease the agent holds, from the change
 * events it hears. It must see the agent's own events too, so it runs before
 * the inbox's `notifies` filter. A lease is the agent's from its
 * IntentDeclared or its ChangeAdopted, and stops being so when another agent
 * adopts the change (which can precede the lapse's own event, as adoption
 * needs only the lease's time to have passed), the lease lapses, or the
 * change ends.
 */
function foldHeldLeases(store: Store, agentId: AgentId, event: EventEnvelope): void {
  if (event.entity.kind !== "change") return;
  const changeId = event.entity.id;
  switch (event.type) {
    case "IntentDeclared": {
      const declared = Schema.decodeUnknownSync(IntentDeclared)(event.payload);
      if (declared.agentId === agentId) store.put(HELD_LEASE, changeId, declared.leaseId);
      return;
    }
    case "ChangeAdopted": {
      const adopted = Schema.decodeUnknownSync(ChangeAdopted)(event.payload);
      if (adopted.agentId === agentId) store.put(HELD_LEASE, changeId, adopted.leaseId);
      else if (adopted.previousAgentId === agentId) store.remove(HELD_LEASE, changeId);
      return;
    }
    case "ChangeParked": {
      const parked = Schema.decodeUnknownSync(ChangeParked)(event.payload);
      if (parked.reason === "lease-lapsed") store.remove(HELD_LEASE, changeId);
      return;
    }
    case "LeaseLapsed":
    case "ChangeLanded":
    case "ChangeWithdrawn":
    case "ChangeSuperseded":
      store.remove(HELD_LEASE, changeId);
      return;
    default:
      return;
  }
}

/**
 * What the AgentSession DO does with each event delivered to it, inside the
 * transaction that receives it: the leases the agent holds follow every
 * event, its own included; the inbox takes only those it did not cause, since
 * its own tool result already reported those.
 */
export function hearEvent(store: Store, agentId: AgentId, event: EventEnvelope): void {
  foldHeldLeases(store, agentId, event);
  if (notifies(agentId, event)) recordDelivery(store, event);
}

/** What the AgentSession DO knows about its agent right now. Fidelity arrives with effect derivation. */
export interface SessionView {
  readonly session: Session | null;
  readonly inboxDepth: number;
  readonly openLeases: number;
}

/** The agent's session state, computed from its rows. An agent never enrolled here is AgentNotKnown. */
export const viewSession: (
  agentId: AgentId,
) => Effect.Effect<SessionView, AgentNotKnown, EntityStore> = Effect.fn("identity/viewSession")(
  function* (agentId: AgentId) {
    const store = yield* EntityStore;
    if (store.get(AGENT, agentId) === undefined) return yield* new AgentNotKnown({ agentId });
    return store.transaction(() => ({
      session: currentSession(store),
      inboxDepth: inboxDepth(store),
      openLeases: store.list(HELD_LEASE).length,
    }));
  },
);

const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
