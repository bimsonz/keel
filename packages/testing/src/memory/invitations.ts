import {
  answersFor,
  decideInvitation,
  eventActorOf,
  evolveInvitation,
  IdempotencyConflict,
  type Invitation,
  type InvitationCommand,
} from "@keeltown/core/domain/identity";
import { type AgentId, Instant, type NamespaceId } from "@keeltown/core/kernel";
import { Invitations, type NamespaceAgentMove, NamespaceAgents } from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Result } from "effect";

const rowKey = (namespace: NamespaceId, agentId: AgentId) => `${namespace}/${agentId}`;

/**
 * NamespaceAgents in memory, with D1's rules: a move changes only a row whose
 * seq is below its own, an acceptance or an end that finds no row changes
 * nothing, and `apply` answers whether the row now holds that move or a later
 * one. An ended row stays, and is in no read.
 */
export function makeNamespaceAgentsMemory() {
  const rows = new Map<string, { readonly invitation: Invitation; readonly seq: number }>();
  const standing = (wanted: (invitation: Invitation) => boolean) =>
    [...rows.values()]
      .map((row) => row.invitation)
      .filter((invitation) => invitation.state !== "ended" && wanted(invitation))
      .toSorted((a, b) => a.invitedAt - b.invitedAt || a.agentId.localeCompare(b.agentId));
  const apply = (move: NamespaceAgentMove, seq: number): boolean => {
    const key = rowKey(move.namespace, move.agentId);
    const held = rows.get(key);
    if (held !== undefined && held.seq >= seq) return true;
    switch (move._tag) {
      case "Invited":
        rows.set(key, {
          invitation: {
            namespace: move.namespace,
            agentId: move.agentId,
            by: move.by,
            scopes: move.scopes,
            state: "invited",
            invitedAt: move.at,
          },
          seq,
        });
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
  };
  const service = NamespaceAgents.of({
    apply: (move, seq) => Effect.sync(() => apply(move, seq)),
    standing: (agentId, namespace) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(answersFor(rows.get(rowKey(namespace, agentId))?.invitation)),
      ),
    find: (agentId, namespace) =>
      Effect.sync(() => {
        const held = rows.get(rowKey(namespace, agentId))?.invitation;
        return held === undefined || held.state === "ended" ? Option.none() : Option.some(held);
      }),
    inNamespace: (namespace) =>
      Effect.sync(() => standing((invitation) => invitation.namespace === namespace)),
    ofAgent: (agentId) =>
      Effect.sync(() => standing((invitation) => invitation.agentId === agentId)),
  });
  return { service, layer: Layer.succeed(NamespaceAgents, service) };
}

/**
 * Invitations over NamespaceAgents, with the namespace object's rules: the
 * domain's Invitation machine decides each move on the record this memory
 * keeps, each event is written to the rows under the namespace's next seq
 * before the move answers, and a key replayed with its body answers the
 * invitation as it stands.
 */
export function makeInvitationsMemory() {
  const held = new Map<string, Invitation>();
  const seqs = new Map<NamespaceId, number>();
  const byKey = new Map<string, string>();
  return {
    layer: Layer.effect(
      Invitations,
      Effect.gen(function* () {
        const rows = yield* NamespaceAgents;
        const move = (
          namespace: NamespaceId,
          agentId: AgentId,
          key: string,
          body: string,
          idempotencyKey: string,
          command: InvitationCommand,
        ) =>
          Effect.gen(function* () {
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const at = rowKey(namespace, agentId);
            const current = held.get(at);
            const replayed = byKey.get(key);
            if (replayed !== undefined) {
              if (replayed !== body) return yield* new IdempotencyConflict({ idempotencyKey });
              if (current !== undefined) return current;
            }
            const decided = decideInvitation(current, command, { namespace, agentId });
            if (Result.isFailure(decided)) return yield* decided.failure;
            let invitation = current;
            for (const payload of decided.success) {
              invitation = evolveInvitation(invitation, { at: now, payload });
              const seq = (seqs.get(namespace) ?? 0) + 1;
              seqs.set(namespace, seq);
              yield* rows.apply(
                payload._tag === "AgentInvited"
                  ? {
                      _tag: "Invited",
                      namespace,
                      agentId,
                      by: payload.by,
                      scopes: payload.scopes,
                      at: now,
                    }
                  : payload._tag === "AgentJoinedNamespace"
                    ? { _tag: "Joined", namespace, agentId, at: now }
                    : { _tag: "Left", namespace, agentId },
                seq,
              );
            }
            if (invitation === undefined)
              return yield* Effect.die(new Error(`${command._tag} left ${agentId} no place`));
            held.set(at, invitation);
            byKey.set(key, body);
            return invitation;
          });
        return Invitations.of({
          invite: ({ namespace, agentId, by, scopes, idempotencyKey }) =>
            move(
              namespace,
              agentId,
              `${namespace} invite ${agentId} ${idempotencyKey}`,
              JSON.stringify([by, scopes.toSorted()]),
              idempotencyKey,
              { _tag: "Invite", by, scopes },
            ),
          accept: ({ namespace, agentId, idempotencyKey }) =>
            move(
              namespace,
              agentId,
              `${namespace} accept ${agentId} ${idempotencyKey}`,
              "accept",
              idempotencyKey,
              { _tag: "Accept" },
            ),
          end: (actor, { namespace, agentId, idempotencyKey }) =>
            move(
              namespace,
              agentId,
              `${namespace} end ${agentId} ${idempotencyKey}`,
              JSON.stringify([eventActorOf(actor)]),
              idempotencyKey,
              { _tag: "End", by: eventActorOf(actor) },
            ),
        });
      }),
    ),
  };
}
