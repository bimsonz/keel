import { Context, type Effect } from "effect";
import type {
  Actor,
  IdempotencyConflict,
  Invitation,
  InvitationRefused,
  InvitationScopes,
} from "../../domain/identity/index.ts";
import type { AgentId, NamespaceId, RunRef, UserId } from "../../domain/kernel/index.ts";

export interface AgentInvitation {
  readonly namespace: NamespaceId;
  readonly agentId: AgentId;
  /** The member inviting, who answers for the agent in the namespace once it accepts. */
  readonly by: UserId;
  readonly scopes: InvitationScopes;
  readonly idempotencyKey: string;
}

export interface InvitationAnswer {
  readonly namespace: NamespaceId;
  readonly agentId: AgentId;
  /** The run the agent answers in, from its token. */
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
}

export interface InvitationEnding {
  readonly namespace: NamespaceId;
  readonly agentId: AgentId;
  /** The run an agent ends its own invitation in, from its token. A person names none. */
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
}

/**
 * An agent's place in a namespace it does not govern, which the namespace's
 * own object holds (`ns:<id>`). It takes two: a member invites and the agent
 * accepts, so no agent is put anywhere it did not agree to be and none joins
 * where nobody answers for it. It gives the agent read and work there, never
 * more, for as long as the member who invited it is a member.
 *
 * - `invite`: one member answers for an agent in a namespace. The same member
 *   inviting again for the same scopes answers the invitation as it stands;
 *   anything else is refused while one stands (`already-invited`).
 * - `accept`: the agent's own. With no invitation there it is refused
 *   (`not-invited`).
 * - `end`: by the agent (it declines or leaves), or by a person, which the
 *   doorway decides: the member who invited it, or a maintainer.
 *
 * Each writes the row the request gate reads (`NamespaceAgents`) before it
 * answers. The same Idempotency-Key and body answers the invitation again;
 * another body is an IdempotencyConflict.
 */
export class Invitations extends Context.Service<
  Invitations,
  {
    readonly invite: (
      invitation: AgentInvitation,
    ) => Effect.Effect<Invitation, InvitationRefused | IdempotencyConflict>;
    readonly accept: (
      answer: InvitationAnswer,
    ) => Effect.Effect<Invitation, InvitationRefused | IdempotencyConflict>;
    readonly end: (
      actor: Actor,
      ending: InvitationEnding,
    ) => Effect.Effect<Invitation, InvitationRefused | IdempotencyConflict>;
  }
>()("keel/Invitations") {}
