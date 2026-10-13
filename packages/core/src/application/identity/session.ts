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
  byAgent,
  ChangeId,
  type EventEnvelope,
  RunId,
  type RunRef,
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
 * current session of each of the agent's runs under the run's id (under
 * `self` for an agent that names no run).
 */
export const SESSION = {
  opened: "session",
  current: { kind: "agent-session-current", id: "self" },
} as const;

/** One row per change whose lease the agent holds, by change id. */
export const HELD_LEASE = "held-lease";

/**
 * One row per change a run of the agent holds, by change id: the run's id. It
 * outlives the lease, so what becomes of the change still reaches the run that
 * held it, and goes when another agent adopts the change.
 */
export const CHANGE_RUN = "change-run";

const Opened = Schema.Struct({ session: Session, fingerprint: Schema.String });
const decodeOpened = Schema.decodeUnknownSync(Opened);
const encodeOpened = Schema.encodeSync(Opened);
const decodeSession = Schema.decodeUnknownSync(Session);
const encodeSession = Schema.encodeSync(Session);
const encodeOpenedEvent = Schema.encodeSync(SessionOpened);
const decodeAgent = Schema.decodeUnknownSync(Agent);

/** An agent's request to open a session, as the isolate sends it. */
export interface OpenSessionCommand {
  /** The run that opens the session, when the agent's token names one. */
  readonly run?: RunRef | undefined;
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
  const { projectId } = decodeAgent(enrolled);
  const sessionId: SessionId = yield* (yield* Ids).next("ses");
  const committed = yield* commit<Session, AgentNotAdmitted | IdempotencyConflict>(
    {
      entity: { kind: "session", id: sessionId },
      cause: `session:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      ...byAgent(agentId, command.run),
      // An agent that signed up by key has no project of its own, so its session names none.
      ...(projectId === undefined ? {} : { project: projectId }),
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
      const session: Session = {
        id: sessionId,
        agentId,
        ...details,
        ...(command.run === undefined ? {} : { run: command.run }),
        openedAt: tx.at,
      };
      tx.store.put(
        SESSION.opened,
        command.idempotencyKey,
        asStored(encodeOpened({ session, fingerprint: command.fingerprint })),
      );
      tx.store.put(
        SESSION.current.kind,
        command.run?.id ?? SESSION.current.id,
        asStored(encodeSession(session)),
      );
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

/** The current session of a run of the agent (of the agent itself, for no run), or null when it has opened none. */
export function currentSession(store: Store, run?: RunId): Session | null {
  const stored = store.get(SESSION.current.kind, run ?? SESSION.current.id);
  return stored === undefined ? null : decodeSession(stored);
}

const isRunId = Schema.is(RunId);
const isChangeId = Schema.is(ChangeId);

/** The run of the agent that holds a change, when one does. */
function runHolding(store: Store, changeId: string): RunId | undefined {
  const run = store.get(CHANGE_RUN, changeId);
  return isRunId(run) ? run : undefined;
}

/** The change now belongs to `run`: to no run when the token that took it named none. */
function heldBy(store: Store, changeId: string, run: RunRef | undefined): void {
  if (run === undefined) store.remove(CHANGE_RUN, changeId);
  else store.put(CHANGE_RUN, changeId, run.id);
}

/**
 * The change an event is about, when it names one: its payload's `changeId`
 * (a change's own events, and a notice another entity commits for a change),
 * a verdict's `subject`, or failing those the change it is an event of.
 */
function changeOf(event: EventEnvelope): ChangeId | undefined {
  const payload: object =
    typeof event.payload === "object" && event.payload !== null ? event.payload : {};
  for (const field of ["changeId", "subject"]) {
    const named: unknown = Reflect.get(payload, field);
    if (isChangeId(named)) return named;
  }
  return event.entity.kind === "change" && isChangeId(event.entity.id)
    ? event.entity.id
    : undefined;
}

/**
 * The one run that holds the changes an event affects, for an event that
 * names no change of its own: a conflict put to a person or ruled on names
 * its parties only there. None when no run holds any of them, and none when
 * two runs each hold one: that event is for both, so for every run.
 */
function soleHolder(store: Store, event: EventEnvelope): RunId | undefined {
  const holders = new Set<RunId>();
  for (const affected of event.affected) {
    const run = affected.kind === "change" ? runHolding(store, affected.id) : undefined;
    if (run !== undefined) holders.add(run);
  }
  const [only, ...more] = holders;
  return more.length === 0 ? only : undefined;
}

/**
 * Keeps one row per change whose lease the agent holds, from the change
 * events it hears. It must see the agent's own events too, so it runs before
 * the inbox's `notifies` filter. A lease is the agent's from its
 * IntentDeclared or its ChangeAdopted, and stops being so when another agent
 * adopts the change (which can precede the lapse's own event, as adoption
 * needs only the lease's time to have passed), the lease lapses, or the
 * change ends. The run that holds the change is kept beside the lease, from
 * the same two events.
 */
function foldHeldLeases(store: Store, agentId: AgentId, event: EventEnvelope): void {
  if (event.entity.kind !== "change") return;
  const changeId = event.entity.id;
  switch (event.type) {
    case "IntentDeclared": {
      const declared = Schema.decodeUnknownSync(IntentDeclared)(event.payload);
      if (declared.agentId === agentId) {
        store.put(HELD_LEASE, changeId, declared.leaseId);
        heldBy(store, changeId, declared.run);
      }
      return;
    }
    case "ChangeAdopted": {
      const adopted = Schema.decodeUnknownSync(ChangeAdopted)(event.payload);
      if (adopted.agentId === agentId) {
        store.put(HELD_LEASE, changeId, adopted.leaseId);
        heldBy(store, changeId, adopted.run);
      } else if (adopted.previousAgentId === agentId) {
        store.remove(HELD_LEASE, changeId);
        store.remove(CHANGE_RUN, changeId);
      }
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
 *
 * An entry is for the run that holds the change the event is about: the run
 * that held it before the event, or failing one the run that holds it after,
 * so a run is told when another takes its change. An event that names no
 * change is for the one run that holds what it affects. An event about no
 * change at all, or about one no run holds, is for every run. What a run does
 * to a change it holds is for that run alone, and it is never shown its own
 * acts, so nothing is kept for it.
 */
export function hearEvent(store: Store, agentId: AgentId, event: EventEnvelope): void {
  const about = changeOf(event);
  const before = about === undefined ? undefined : runHolding(store, about);
  foldHeldLeases(store, agentId, event);
  if (!notifies(agentId, event)) return;
  const holder =
    about === undefined ? soleHolder(store, event) : (before ?? runHolding(store, about));
  if (holder !== undefined && event.run?.id === holder) return;
  recordDelivery(store, event, holder);
}

/** What the AgentSession DO knows about its agent right now. Fidelity arrives with effect derivation. */
export interface SessionView {
  readonly session: Session | null;
  readonly inboxDepth: number;
  readonly openLeases: number;
}

/**
 * The agent's session state as one of its runs sees it, computed from its
 * rows: that run's current session and the notices waiting for it, and the
 * leases the agent holds. An agent never enrolled here is AgentNotKnown.
 */
export const viewSession: (
  agentId: AgentId,
  run?: RunId,
) => Effect.Effect<SessionView, AgentNotKnown, EntityStore> = Effect.fn("identity/viewSession")(
  function* (agentId: AgentId, run?: RunId) {
    const store = yield* EntityStore;
    if (store.get(AGENT, agentId) === undefined) return yield* new AgentNotKnown({ agentId });
    return store.transaction(() => ({
      session: currentSession(store, run),
      inboxDepth: inboxDepth(store, run),
      openLeases: store.list(HELD_LEASE).length,
    }));
  },
);

const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
