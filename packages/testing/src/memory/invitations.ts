import {
  answersFor,
  decideInvitation,
  eventActorOf,
  evolveInvitation,
  IdempotencyConflict,
  type Invitation,
  type InvitationCommand,
} from "@keeltown/core/domain/identity";
import { type AgentId, Instant, type NamespaceId, type ProjectId } from "@keeltown/core/kernel";
import {
  Invitations,
  type NamespaceAgentMove,
  NamespaceAgents,
  type ProjectAgentMove,
  ProjectAgents,
} from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Result } from "effect";

/** What either kind of row is told of a move, once its place has picked the row. */
type RowMove =
  | { readonly _tag: "Invited"; readonly invitation: Invitation }
  | { readonly _tag: "Joined"; readonly at: Instant }
  | { readonly _tag: "Left" };

/**
 * Rows in memory with D1's rules, whatever the place: a move changes only a
 * row whose seq is below its own, an acceptance or an end that finds no row
 * changes nothing, and `apply` answers whether the row now holds that move or
 * a later one. An ended row stays, and is in no read.
 */
function makeRows() {
  const rows = new Map<string, { readonly invitation: Invitation; readonly seq: number }>();
  return {
    held: (key: string) => rows.get(key)?.invitation,
    standing: (wanted: (invitation: Invitation) => boolean) =>
      [...rows.values()]
        .map((row) => row.invitation)
        .filter((invitation) => invitation.state !== "ended" && wanted(invitation))
        .toSorted((a, b) => a.invitedAt - b.invitedAt || a.agentId.localeCompare(b.agentId)),
    apply: (key: string, move: RowMove, seq: number): boolean => {
      const held = rows.get(key);
      if (held !== undefined && held.seq >= seq) return true;
      switch (move._tag) {
        case "Invited":
          rows.set(key, { invitation: move.invitation, seq });
          return true;
        case "Joined":
          if (held === undefined) return false;
          rows.set(key, {
            invitation: { ...held.invitation, state: "joined", joinedAt: move.at },
            seq,
          });
          return true;
        case "Left":
          if (held === undefined) return false;
          rows.set(key, { invitation: { ...held.invitation, state: "ended" }, seq });
          return true;
        default: {
          const unmatched: never = move;
          return unmatched;
        }
      }
    },
  };
}

const present = (held: Invitation | undefined) =>
  held === undefined || held.state === "ended" ? Option.none() : Option.some(held);

const rowKey = (place: string, agentId: AgentId) => `${place}/${agentId}`;

/** What a namespace's move tells its row. */
const namespaceMove = (move: NamespaceAgentMove): RowMove =>
  move._tag === "Invited"
    ? {
        _tag: "Invited",
        invitation: {
          namespace: move.namespace,
          agentId: move.agentId,
          by: move.by,
          scopes: move.scopes,
          state: "invited",
          invitedAt: move.at,
        },
      }
    : move._tag === "Joined"
      ? { _tag: "Joined", at: move.at }
      : { _tag: "Left" };

/** NamespaceAgents in memory, with D1's rules (`makeRows`): one row an agent in a namespace. */
export function makeNamespaceAgentsMemory() {
  const rows = makeRows();
  const service = NamespaceAgents.of({
    apply: (move, seq) =>
      Effect.sync(() => rows.apply(rowKey(move.namespace, move.agentId), namespaceMove(move), seq)),
    standing: (agentId, namespace) =>
      Effect.sync(() => Option.fromUndefinedOr(answersFor(rows.held(rowKey(namespace, agentId))))),
    find: (agentId, namespace) => Effect.sync(() => present(rows.held(rowKey(namespace, agentId)))),
    inNamespace: (namespace) =>
      Effect.sync(() => rows.standing((invitation) => invitation.namespace === namespace)),
    ofAgent: (agentId) =>
      Effect.sync(() => rows.standing((invitation) => invitation.agentId === agentId)),
    ended: (agentId, namespace) =>
      Effect.sync(() => rows.held(rowKey(namespace, agentId))?.state === "ended"),
  });
  return { service, layer: Layer.succeed(NamespaceAgents, service) };
}

/** What a project's move tells its row. */
const projectMove = (move: ProjectAgentMove): RowMove =>
  move._tag === "Invited"
    ? {
        _tag: "Invited",
        invitation: {
          namespace: move.namespace,
          projectId: move.projectId,
          agentId: move.agentId,
          by: move.by,
          scopes: move.scopes,
          state: "invited",
          invitedAt: move.at,
        },
      }
    : move._tag === "Joined"
      ? { _tag: "Joined", at: move.at }
      : { _tag: "Left" };

/** ProjectAgents in memory, with the same rules: one row an agent on a project. */
export function makeProjectAgentsMemory() {
  const rows = makeRows();
  const service = ProjectAgents.of({
    apply: (move, seq) =>
      Effect.sync(() => rows.apply(rowKey(move.projectId, move.agentId), projectMove(move), seq)),
    standing: (agentId, projectId) =>
      Effect.sync(() => Option.fromUndefinedOr(answersFor(rows.held(rowKey(projectId, agentId))))),
    find: (agentId, projectId) => Effect.sync(() => present(rows.held(rowKey(projectId, agentId)))),
    inProject: (projectId) =>
      Effect.sync(() => rows.standing((invitation) => invitation.projectId === projectId)),
    ofAgent: (agentId) =>
      Effect.sync(() => rows.standing((invitation) => invitation.agentId === agentId)),
    ended: (agentId, projectId) =>
      Effect.sync(() => rows.held(rowKey(projectId, agentId))?.state === "ended"),
  });
  return { service, layer: Layer.succeed(ProjectAgents, service) };
}

/**
 * Invitations over NamespaceAgents and ProjectAgents, with the rules of the
 * object that holds each record (the namespace's own, or one project's): the
 * domain's Invitation machine decides each move on the record this memory
 * keeps, each event is written to that place's rows under its next seq before
 * the move answers, and a key replayed with its body answers the invitation as
 * it stands.
 */
export function makeInvitationsMemory() {
  const held = new Map<string, Invitation>();
  const seqs = new Map<string, number>();
  const byKey = new Map<string, string>();
  return {
    layer: Layer.effect(
      Invitations,
      Effect.gen(function* () {
        const ofNamespaces = yield* NamespaceAgents;
        const ofProjects = yield* ProjectAgents;
        const move = (
          place: { readonly namespace: NamespaceId; readonly projectId?: ProjectId | undefined },
          agentId: AgentId,
          what: string,
          body: string,
          idempotencyKey: string,
          command: InvitationCommand,
        ) =>
          Effect.gen(function* () {
            const { namespace, projectId } = place;
            const where = projectId ?? namespace;
            const key = `${where} ${what} ${agentId} ${idempotencyKey}`;
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const at = rowKey(where, agentId);
            const current = held.get(at);
            const replayed = byKey.get(key);
            if (replayed !== undefined) {
              if (replayed !== body) return yield* new IdempotencyConflict({ idempotencyKey });
              if (current !== undefined) return current;
            }
            const decided = decideInvitation(current, command, { namespace, agentId, projectId });
            if (Result.isFailure(decided)) return yield* decided.failure;
            let invitation = current;
            for (const payload of decided.success) {
              invitation = evolveInvitation(invitation, { at: now, payload });
              const seq = (seqs.get(where) ?? 0) + 1;
              seqs.set(where, seq);
              switch (payload._tag) {
                case "AgentInvited":
                  yield* ofNamespaces.apply({ ...payload, _tag: "Invited", at: now }, seq);
                  break;
                case "AgentJoinedNamespace":
                  yield* ofNamespaces.apply({ _tag: "Joined", namespace, agentId, at: now }, seq);
                  break;
                case "AgentLeftNamespace":
                  yield* ofNamespaces.apply({ _tag: "Left", namespace, agentId }, seq);
                  break;
                case "AgentInvitedToProject":
                  yield* ofProjects.apply({ ...payload, _tag: "Invited", at: now }, seq);
                  break;
                case "AgentJoinedProject":
                  yield* ofProjects.apply(
                    { _tag: "Joined", projectId: payload.projectId, agentId, at: now },
                    seq,
                  );
                  break;
                case "AgentLeftProject":
                  yield* ofProjects.apply(
                    { _tag: "Left", projectId: payload.projectId, agentId },
                    seq,
                  );
                  break;
                default: {
                  const unmatched: never = payload;
                  return unmatched;
                }
              }
            }
            if (invitation === undefined)
              return yield* Effect.die(new Error(`${command._tag} left ${agentId} no place`));
            held.set(at, invitation);
            byKey.set(key, body);
            return invitation;
          });
        return Invitations.of({
          invite: ({ agentId, by, scopes, idempotencyKey, ...place }) =>
            move(
              place,
              agentId,
              "invite",
              JSON.stringify([by, scopes.toSorted()]),
              idempotencyKey,
              { _tag: "Invite", by, scopes },
            ),
          accept: ({ agentId, idempotencyKey, ...place }) =>
            move(place, agentId, "accept", "accept", idempotencyKey, { _tag: "Accept" }),
          end: (actor, { agentId, idempotencyKey, ...place }) =>
            move(place, agentId, "end", JSON.stringify([eventActorOf(actor)]), idempotencyKey, {
              _tag: "End",
              by: eventActorOf(actor),
            }),
        });
      }),
    ),
  };
}

/** Invitations in memory over fresh rows of both kinds: what a world that only needs the three ports provides. */
export const invitationsMemoryLayer = () =>
  makeInvitationsMemory().layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(makeNamespaceAgentsMemory().layer, makeProjectAgentsMemory().layer),
    ),
  );
