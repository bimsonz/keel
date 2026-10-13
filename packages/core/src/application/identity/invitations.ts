import { Effect, Option, Result, Schema } from "effect";
import {
  AgentInvited,
  AgentInvitedToProject,
  AgentJoinedNamespace,
  AgentJoinedProject,
  AgentLeftNamespace,
  AgentLeftProject,
  answersFor,
  decideInvitation,
  evolveInvitation,
  IdempotencyConflict,
  Invitation,
  type InvitationCommand,
  InvitationEvent,
  type InvitationRefused,
  type InvitationScopes,
} from "../../domain/identity/index.ts";
import {
  type AgentId,
  byAgent,
  type EntityRef,
  type CommandActor as EventActor,
  type EventEnvelope,
  IllegalTransition,
  InstantSchema,
  type NamespaceId,
  type ProjectId,
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
  type ProjectAgentMove,
  ProjectAgents,
  type Stored,
} from "../ports/index.ts";

/** The store kind of a namespace's agents: one row an agent, in the namespace's own object. */
export const NAMESPACE_AGENT = "namespace-agent";

/** The store kind of the agents invited to a project: one row an agent, in the project's own object. */
export const PROJECT_AGENT = "project-agent";

/** What an agent is told of its place in a namespace: a member invited it, or its invitation ended. */
export const INVITATION_TELLS = ["AgentInvited", "AgentLeftNamespace"] as const;

/** What an agent is told of its place on a project: its person invited it, or its invitation ended. */
export const PROJECT_INVITATION_TELLS = ["AgentInvitedToProject", "AgentLeftProject"] as const;

const decodeInvitation = Schema.decodeUnknownSync(Invitation);
const encodeInvitation = Schema.encodeSync(Invitation);
const encodeEvent = Schema.encodeSync(InvitationEvent);
const decodeInvited = Schema.decodeUnknownOption(AgentInvited);
const decodeJoined = Schema.decodeUnknownOption(AgentJoinedNamespace);
const decodeLeft = Schema.decodeUnknownOption(AgentLeftNamespace);
const decodeInvitedTo = Schema.decodeUnknownOption(AgentInvitedToProject);
const decodeJoinedProject = Schema.decodeUnknownOption(AgentJoinedProject);
const decodeLeftProject = Schema.decodeUnknownOption(AgentLeftProject);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/** The entity a namespace's own events are committed on (`org:<id>`). */
export const namespaceRef = (namespace: NamespaceId): EntityRef => ({ kind: "org", id: namespace });

/**
 * Where an invitation is kept: a namespace's own record, or the record of one
 * project of it, in that project's own object.
 */
export interface InvitationPlace {
  readonly namespace: NamespaceId;
  readonly projectId?: ProjectId | undefined;
}

/** A project, as the place of an invitation to it alone. */
export type ProjectPlace = InvitationPlace & { readonly projectId: ProjectId };

type Store = (typeof EntityStore)["Service"];

const invitationOf = (
  store: Store,
  agentId: AgentId,
  kind: string = NAMESPACE_AGENT,
): Invitation | undefined => {
  const stored = store.get(kind, agentId);
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
 * The move a project invitation's event makes on the row the gate reads, with
 * the project's event number that guards it; any other event is none.
 */
export function projectMoveOf(
  event: Pick<EventEnvelope, "type" | "payload" | "at" | "seq">,
): { readonly move: ProjectAgentMove; readonly seq: number } | undefined {
  const { at, seq } = event;
  switch (event.type) {
    case "AgentInvitedToProject":
      return Option.match(decodeInvitedTo(event.payload), {
        onNone: () => undefined,
        onSome: ({ projectId, namespace, agentId, by, scopes }) => ({
          move: { _tag: "Invited" as const, projectId, namespace, agentId, by, scopes, at },
          seq,
        }),
      });
    case "AgentJoinedProject":
      return Option.match(decodeJoinedProject(event.payload), {
        onNone: () => undefined,
        onSome: ({ projectId, agentId }) => ({
          move: { _tag: "Joined" as const, projectId, agentId, at },
          seq,
        }),
      });
    case "AgentLeftProject":
      return Option.match(decodeLeftProject(event.payload), {
        onNone: () => undefined,
        onSome: ({ projectId, agentId }) => ({
          move: { _tag: "Left" as const, projectId, agentId },
          seq,
        }),
      });
    default:
      return undefined;
  }
}

type RowEvent = Pick<EventEnvelope, "type" | "payload" | "at" | "seq">;

/** Writes a namespace invitation's event to the row the gate reads; any other event writes nothing. */
const writeNamespaceRow = (event: RowEvent): Effect.Effect<boolean, never, NamespaceAgents> => {
  const moved = invitationMoveOf(event);
  return moved === undefined
    ? Effect.succeed(true)
    : NamespaceAgents.use((rows) => rows.apply(moved.move, moved.seq));
};

/** Writes a project invitation's event to the row the gate reads; any other event writes nothing. */
const writeProjectRow = (event: RowEvent): Effect.Effect<boolean, never, ProjectAgents> => {
  const moved = projectMoveOf(event);
  return moved === undefined
    ? Effect.succeed(true)
    : ProjectAgents.use((rows) => rows.apply(moved.move, moved.seq));
};

/**
 * Whom an invitation's event concerns, beyond its namespace or its project:
 * the agent, so it alone hears of its own place here, and whoever invited it.
 */
const concerning = (event: InvitationEvent): readonly EntityRef[] => [
  { kind: "agent", id: event.agentId },
  ...(event._tag === "AgentInvited" || event._tag === "AgentInvitedToProject"
    ? [{ kind: "user" as const, id: event.by }]
    : []),
];

/**
 * Commits one move on an agent's place through the domain's Invitation
 * machine, on the place's own entity (the namespace's, or the project's, with
 * the project on every event), then writes the row the request gate reads
 * before answering, guarded by the event's seq; the Projector repeats the
 * write on delivery. The agent is subscribed to what concerns it here when it
 * is invited, in the same transaction, so it is told of the invitation and of
 * an end somebody else makes, and of no other agent's.
 */
const moveInvitation = Effect.fn("identity/moveInvitation")(function* <R>(
  place: InvitationPlace,
  agentId: AgentId,
  spec: {
    readonly cause: string;
    readonly fingerprint: string;
    readonly actor: EventActor;
    readonly run?: RunRef | undefined;
  },
  idempotencyKey: string,
  command: InvitationCommand,
  write: (event: RowEvent) => Effect.Effect<boolean, never, R>,
) {
  const { namespace, projectId } = place;
  const kind = projectId === undefined ? NAMESPACE_AGENT : PROJECT_AGENT;
  const where = projectId ?? namespace;
  const store = yield* EntityStore;
  const committed = yield* commit(
    {
      entity:
        projectId === undefined ? namespaceRef(namespace) : { kind: "project", id: projectId },
      cause: spec.cause,
      fingerprint: spec.fingerprint,
      actor: spec.actor,
      ...(spec.run === undefined ? {} : { run: spec.run }),
      ...(projectId === undefined ? {} : { project: projectId }),
    },
    (tx) => {
      const current = invitationOf(tx.store, agentId, kind);
      const decided = decideInvitation(current, command, { namespace, agentId, projectId });
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
        throw new IllegalTransition(`${command._tag} left ${agentId} no place in ${where}`);
      tx.store.put(kind, agentId, asStored(encodeInvitation(invitation)));
      if (decided.success.some((event) => event._tag === "AgentInvited"))
        tx.outbox.subscribe(`agent:${agentId}`, INVITATION_TELLS, { kind: "agent", id: agentId });
      if (decided.success.some((event) => event._tag === "AgentInvitedToProject"))
        tx.outbox.subscribe(`agent:${agentId}`, PROJECT_INVITATION_TELLS, {
          kind: "agent",
          id: agentId,
        });
      return Result.succeed({ value: invitation, drafts });
    },
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey });
  for (const event of committed.events) yield* write(event);
  if (!committed.duplicate) return committed.value;
  const held = invitationOf(store, agentId, kind);
  if (held === undefined)
    throw new IllegalTransition(`${spec.cause} committed and ${agentId} has no place in ${where}`);
  return held;
});

const invite = <R>(
  place: InvitationPlace,
  command: InviteAgent,
  write: (event: RowEvent) => Effect.Effect<boolean, never, R>,
) =>
  moveInvitation(
    place,
    command.agentId,
    {
      cause: `invite:${command.agentId}:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: userActor(command.by),
    },
    command.idempotencyKey,
    { _tag: "Invite", by: command.by, scopes: command.scopes },
    write,
  );

const accept = <R>(
  place: InvitationPlace,
  command: AcceptInvitation,
  write: (event: RowEvent) => Effect.Effect<boolean, never, R>,
) =>
  moveInvitation(
    place,
    command.agentId,
    {
      cause: `accept:${command.agentId}:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      ...byAgent(command.agentId, command.run),
    },
    command.idempotencyKey,
    { _tag: "Accept" },
    write,
  );

const end = <R>(
  place: InvitationPlace,
  command: EndInvitation,
  write: (event: RowEvent) => Effect.Effect<boolean, never, R>,
) =>
  moveInvitation(
    place,
    command.agentId,
    {
      cause: `end:${command.agentId}:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: command.by,
      run: command.run,
    },
    command.idempotencyKey,
    { _tag: "End", by: command.by },
    write,
  );

/** A member invites an agent into this namespace, idempotent by the member's key for that agent. */
export const inviteAgent = (namespace: NamespaceId, command: InviteAgent) =>
  invite({ namespace }, command, writeNamespaceRow);

/** The agent accepts its invitation into this namespace, in the run its token names. */
export const acceptInvitation = (namespace: NamespaceId, command: AcceptInvitation) =>
  accept({ namespace }, command, writeNamespaceRow);

/** The agent's invitation into this namespace ends: by the agent itself, or by a person the doorway let through. */
export const endInvitation = (namespace: NamespaceId, command: EndInvitation) =>
  end({ namespace }, command, writeNamespaceRow);

/** The person whose namespace the project is in invites an agent to it alone, idempotent by their key for that agent. */
export const inviteToProject = (place: ProjectPlace, command: InviteAgent) =>
  invite(place, command, writeProjectRow);

/** The agent accepts its invitation to this project, in the run its token names. */
export const acceptProjectInvitation = (place: ProjectPlace, command: AcceptInvitation) =>
  accept(place, command, writeProjectRow);

/** The agent's invitation to this project ends: by the agent itself, or by the person the doorway let through. */
export const endProjectInvitation = (place: ProjectPlace, command: EndInvitation) =>
  end(place, command, writeProjectRow);

/** The agents invited to this project, as its own object holds them: one row an agent, an ended one among them. */
export const projectInvitationOf = (store: Store, agentId: AgentId): Invitation | undefined =>
  invitationOf(store, agentId, PROJECT_AGENT);

/**
 * The Projector's repair of the rows the gate reads: each invitation event it
 * receives, a namespace's or a project's, is noted here in the receipt's
 * transaction, and applied once the transaction is done, in its place's own
 * order. The inline write normally got there first, and the seq guard makes
 * the repeat a no-op. A move stays noted until its row holds it: an acceptance
 * waits for its invitation's row.
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
  const ofNamespace = invitationMoveOf(event)?.move;
  const ofProject = ofNamespace === undefined ? projectMoveOf(event)?.move : undefined;
  const row =
    ofNamespace === undefined
      ? ofProject === undefined
        ? undefined
        : `${ofProject.projectId}/${ofProject.agentId}`
      : `${ofNamespace.namespace}/${ofNamespace.agentId}`;
  if (row === undefined) return;
  store.put(
    NAMESPACE_AGENT_PENDING,
    `${row}/${String(event.seq).padStart(12, "0")}`,
    asStored({ type: event.type, payload: event.payload, at: event.at, seq: event.seq }),
  );
}

/**
 * Applies every noted move to the rows, oldest first, and forgets each once
 * its row holds it. A write that fails stays noted for the next delivery's
 * repair.
 */
export const repairInvitations: Effect.Effect<
  void,
  never,
  EntityStore | NamespaceAgents | ProjectAgents
> = Effect.gen(function* () {
  const store = yield* EntityStore;
  const noted = store
    .list(NAMESPACE_AGENT_PENDING)
    .map(({ id, value }) => ({ id, event: decodeNoted(value) }))
    .toSorted((a, b) => a.event.seq - b.event.seq);
  for (const { id, event } of noted) {
    // Each event is one place's: the other writer finds no move in it and answers that it holds.
    const held = yield* Effect.exit(
      Effect.zipWith(writeNamespaceRow(event), writeProjectRow(event), (a, b) => a && b),
    );
    if (held._tag === "Failure" || !held.value) continue;
    store.transaction(() => store.remove(NAMESPACE_AGENT_PENDING, id));
  }
});
