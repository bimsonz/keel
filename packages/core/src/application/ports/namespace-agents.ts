import { Context, type Effect, type Option } from "effect";
import type { Invitation, InvitationScopes } from "../../domain/identity/index.ts";
import type { AgentId, Instant, NamespaceId, UserId } from "../../domain/kernel/index.ts";

/** One move of an agent's place in a namespace, as its event tells it. */
export type NamespaceAgentMove =
  | {
      readonly _tag: "Invited";
      readonly namespace: NamespaceId;
      readonly agentId: AgentId;
      readonly by: UserId;
      readonly scopes: InvitationScopes;
      readonly at: Instant;
    }
  | {
      readonly _tag: "Joined";
      readonly namespace: NamespaceId;
      readonly agentId: AgentId;
      readonly at: Instant;
    }
  | { readonly _tag: "Left"; readonly namespace: NamespaceId; readonly agentId: AgentId };

/** Who answers for an agent in a namespace, and what its invitation lets it hold there. */
export interface InvitedStanding {
  readonly by: UserId;
  readonly scopes: InvitationScopes;
}

/**
 * The agents of each namespace, as rows the request gate can read: a
 * projection of the record every namespace's own object keeps (the
 * `Invitations` port moves it).
 *
 * - `apply` writes one move, guarded by `seq`, the namespace's event number:
 *   a move at or below the row's own changes nothing. It answers whether the
 *   row now holds that move or a later one. An acceptance or an end that
 *   finds no row answers false: its invitation has not been written yet, and
 *   the caller applies it again after that.
 * - `standing` answers only for an accepted invitation: a pending one and an
 *   ended one give nothing.
 * - `find` answers a row that stands, pending or accepted; `inNamespace` and
 *   `ofAgent` list those, oldest invitation first. An ended row is in none.
 */
export class NamespaceAgents extends Context.Service<
  NamespaceAgents,
  {
    readonly apply: (move: NamespaceAgentMove, seq: number) => Effect.Effect<boolean>;
    readonly standing: (
      agentId: AgentId,
      namespace: NamespaceId,
    ) => Effect.Effect<Option.Option<InvitedStanding>>;
    readonly find: (
      agentId: AgentId,
      namespace: NamespaceId,
    ) => Effect.Effect<Option.Option<Invitation>>;
    readonly inNamespace: (namespace: NamespaceId) => Effect.Effect<readonly Invitation[]>;
    readonly ofAgent: (agentId: AgentId) => Effect.Effect<readonly Invitation[]>;
  }
>()("keel/NamespaceAgents") {}
