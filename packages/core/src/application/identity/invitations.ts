import { Effect, Option, Result, Schema } from "effect";
import {
  AgentInvited,
  AgentJoinedNamespace,
  AgentLeftNamespace,
  answersFor,
  decideInvitation,
  evolveInvitation,
  IdempotencyConflict,
  Invitation,
  type InvitationCommand,
  type InvitationRefused,
  type InvitationScopes,
  NamespaceAgentEvent,
} from "../../domain/identity/index.ts";
import {
  type AgentId,
  byAgent,
  type EntityRef,
  type Actor as EventActor,
  type EventEnvelope,
  IllegalTransition,
  InstantSchema,
  type NamespaceId,
  type RunRef,
  userActor,
  type UserId,
} from "../../domain/kernel/index.ts";
import {
  commit,
  EntityStore,
  type EventDraft,
  type NamespaceAgentMove,
  NamespaceAgents,
  type Stored,
} from "../ports/index.ts";

/** The store kind of a namespace's agents: one row an agent, in the namespace's own object. */
export const NAMESPACE_AGENT = "namespace-agent";

/** What an agent is told of its place in a namespace: a member invited it, or its invitation ended. */
export const INVITATION_TELLS = ["AgentInvited", "AgentLeftNamespace"] as const;

const decodeInvitation = Schema.decodeUnknownSync(Invitation);
const encodeInvitation = Schema.encodeSync(Invitation);
const encodeEvent = Schema.encodeSync(NamespaceAgentEvent);
const decodeInvited = Schema.decodeUnknownOption(AgentInvited);
const decodeJoined = Schema.decodeUnknownOption(AgentJoinedNamespace);
const decodeLeft = Schema.decodeUnknownOption(AgentLeftNamespace);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/** The entity a namespace's own events are committed on (`org:<id>`). */
export const namespaceRef = (namespace: NamespaceId): EntityRef => ({ kind: "org", id: namespace });

type Store = (typeof EntityStore)["Service"];

const invitationOf = (store: Store, agentId: AgentId): Invitation | undefined => {
  const stored = store.get(NAMESPACE_AGENT, agentId);
  return stored === undefined ? undefined : decodeInvitation(stored);
};

/**
 * The member who answers for an agent in this namespace: the one who invited
 * it, once it has accepted. Read from the namespace's own record, so whoever
 * raises a question about the agent's work here asks that member first.
 */
export const invitedBy = (store: Store, agentId: AgentId): UserId | undefined =>
  answersFor(invitationOf(store, agentId))?.by;

/** A member's invitation, as the isolate sends it. */
export interface InviteAgent {
  readonly agentId: AgentId;
  readonly by: UserId;
  readonly scopes: InvitationScopes;
  readonly idempotencyKey: string;
  /** A hash of the request, so a reused key is told apart from a retry. */
  readonly fingerprint: string;
}

/** The agent's acceptance, as the isolate sends it: `run` is the run it answers in. */
export interface AcceptInvitation {
  readonly agentId: AgentId;
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/** An invitation's end, as the isolate sends it: `by` is the agent itself or a person, `run` the run an agent ends it in. */
export interface EndInvitation {
  readonly agentId: AgentId;
  readonly by: EventActor;
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/**
 * The move an invitation's event makes on the row the gate reads, with the
 * namespace's event number that guards it; any other event is none.
 */
export function invitationMoveOf(
  event: Pick<EventEnvelope, "type" | "payload" | "at" | "seq">,
): { readonly move: NamespaceAgentMove; readonly seq: number } | undefined {
  const { at, seq } = event;
  switch (event.type) {
    case "AgentInvited":
      return Option.match(decodeInvited(event.payload), {
        onNone: () => undefined,
        onSome: ({ namespace, agentId, by, scopes }) => ({
          move: { _tag: "Invited" as const, namespace, agentId, by, scopes, at },
          seq,
        }),
      });
    case "AgentJoinedNamespace":
      return Option.match(decodeJoined(event.payload), {
        onNone: () => undefined,
        onSome: ({ namespace, agentId }) => ({
          move: { _tag: "Joined" as const, namespace, agentId, at },
          seq,
        }),
      });
    case "AgentLeftNamespace":
      return Option.match(decodeLeft(event.payload), {
        onNone: () => undefined,
        onSome: ({ namespace, agentId }) => ({
          move: { _tag: "Left" as const, namespace, agentId },
          seq,
        }),
      });
    default:
      return undefined;
  }
}

/**
 * Whom an invitation's event concerns, beyond the namespace: the agent, so it
 * alone hears of its own place here, and the member who invited it.
 */
const concerning = (event: NamespaceAgentEvent): readonly EntityRef[] => [
  { kind: "agent", id: event.agentId },
  ...(event._tag === "AgentInvited" ? [{ kind: "user" as const, id: event.by }] : []),
];

/**
 * Commits one move on an agent's place in this namespace through the domain's
 * Invitation machine, on the namespace's own entity, then writes the row the
 * request gate reads before answering, guarded by the event's seq; the
 * Projector repeats the write on delivery. The agent is subscribed to what
 * concerns it here when it is invited, in the same transaction, so it is told
 * of the invitation and of an end somebody else makes, and of no other
 * agent's.
 */
const moveInvitation = Effect.fn("identity/moveInvitation")(function* (
  namespace: NamespaceId,
  agentId: AgentId,
  spec: {
    readonly cause: string;
    readonly fingerprint: string;
    readonly actor: EventActor;
    readonly run?: RunRef | undefined;
  },
  idempotencyKey: string,
  command: InvitationCommand,
) {
  const store = yield* EntityStore;
  const committed = yield* commit(
    {
      entity: namespaceRef(namespace),
      cause: spec.cause,
      fingerprint: spec.fingerprint,
      actor: spec.actor,
      ...(spec.run === undefined ? {} : { run: spec.run }),
    },
    (tx) => {
      const current = invitationOf(tx.store, agentId);
      const decided = decideInvitation(current, command, { namespace, agentId });
      if (Result.isFailure(decided)) return Result.fail<InvitationRefused>(decided.failure);
      let invitation = current;
      const drafts: EventDraft[] = [];
      for (const payload of decided.success) {
        invitation = evolveInvitation(invitation, { at: tx.at, payload });
        drafts.push({
          payload: JSON.parse(JSON.stringify(encodeEvent(payload))),
          affected: concerning(payload),
        });
      }
      if (invitation === undefined)
        throw new IllegalTransition(`${command._tag} left ${agentId} no place in ${namespace}`);
      tx.store.put(NAMESPACE_AGENT, agentId, asStored(encodeInvitation(invitation)));
      if (decided.success.some((event) => event._tag === "AgentInvited"))
        tx.outbox.subscribe(`agent:${agentId}`, INVITATION_TELLS, { kind: "agent", id: agentId });
      return Result.succeed({ value: invitation, drafts });
    },
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey });
  const rows = yield* NamespaceAgents;
  for (const event of committed.events) {
    const moved = invitationMoveOf(event);
    if (moved !== undefined) yield* rows.apply(moved.move, moved.seq);
  }
  if (!committed.duplicate) return committed.value;
  const held = invitationOf(store, agentId);
  if (held === undefined)
    throw new IllegalTransition(
      `${spec.cause} committed and ${agentId} has no place in ${namespace}`,
    );
  return held;
});

/** A member invites an agent into this namespace, idempotent by the member's key for that agent. */
export const inviteAgent = (namespace: NamespaceId, command: InviteAgent) =>
  moveInvitation(
    namespace,
    command.agentId,
    {
      cause: `invite:${command.agentId}:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: userActor(command.by),
    },
    command.idempotencyKey,
    { _tag: "Invite", by: command.by, scopes: command.scopes },
  );

/** The agent accepts its invitation into this namespace, in the run its token names. */
export const acceptInvitation = (namespace: NamespaceId, command: AcceptInvitation) =>
  moveInvitation(
    namespace,
    command.agentId,
    {
      cause: `accept:${command.agentId}:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      ...byAgent(command.agentId, command.run),
    },
    command.idempotencyKey,
    { _tag: "Accept" },
  );

/** The agent's invitation into this namespace ends: by the agent itself, or by a person the doorway let through. */
export const endInvitation = (namespace: NamespaceId, command: EndInvitation) =>
  moveInvitation(
    namespace,
    command.agentId,
    {
      cause: `end:${command.agentId}:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: command.by,
      run: command.run,
    },
    command.idempotencyKey,
    { _tag: "End", by: command.by },
  );

/**
 * The Projector's repair of the rows the gate reads: each invitation event it
 * receives is noted here in the receipt's transaction, and applied once the
 * transaction is done, in the namespace's own order. The inline write normally
 * got there first, and the seq guard makes the repeat a no-op. A move stays
 * noted until its row holds it: an acceptance waits for its invitation's row.
 */
export const NAMESPACE_AGENT_PENDING = "namespace-agent-pending";

const Noted = Schema.Struct({
  type: Schema.String,
  payload: Schema.Unknown,
  at: InstantSchema,
  seq: Schema.Int,
});
const decodeNoted = Schema.decodeUnknownSync(Noted);

/** Notes an invitation's event for `repairInvitations`; any other event is ignored. */
export function noteInvitation(store: Store, event: EventEnvelope): void {
  const moved = invitationMoveOf(event);
  if (moved === undefined) return;
  const { namespace, agentId } = moved.move;
  store.put(
    NAMESPACE_AGENT_PENDING,
    `${namespace}/${agentId}/${String(moved.seq).padStart(12, "0")}`,
    asStored({ type: event.type, payload: event.payload, at: event.at, seq: event.seq }),
  );
}

/**
 * Applies every noted move to the rows, oldest first, and forgets each once
 * its row holds it. A write that fails stays noted for the next delivery's
 * repair.
 */
export const repairInvitations: Effect.Effect<void, never, EntityStore | NamespaceAgents> =
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const rows = yield* NamespaceAgents;
    const noted = store
      .list(NAMESPACE_AGENT_PENDING)
      .map(({ id, value }) => ({ id, event: decodeNoted(value) }))
      .toSorted((a, b) => a.event.seq - b.event.seq);
    for (const { id, event } of noted) {
      const moved = invitationMoveOf(event);
      const held =
        moved === undefined ? true : yield* Effect.exit(rows.apply(moved.move, moved.seq));
      if (held !== true && (held._tag === "Failure" || !held.value)) continue;
      store.transaction(() => store.remove(NAMESPACE_AGENT_PENDING, id));
    }
  });
