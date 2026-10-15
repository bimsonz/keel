import { Context, type Effect } from "effect";
import type {
  Actor,
  Agent,
  AgentNotKnown,
  AgentStateRefused,
  IdempotencyConflict,
  SponsorRequestRefused,
  SponsorRequestsLimited,
} from "../../domain/identity/index.ts";
import type { AgentId, Instant, RunRef, UserId } from "../../domain/kernel/index.ts";

/** An agent's request for a sponsor: the code it shows a person, and when it stops being good. */
export interface SponsorRequest {
  readonly code: string;
  readonly expiresAt: Instant;
}

/**
 * How the agent asked for the link a person is approving. `Code` is the code
 * the agent was given and showed the person. `Consent` is the OAuth provider's
 * consent flow, where the agent's ask is the authorization request its own
 * tool made: only that flow's approval hook says so. `List` is the person's own
 * list: the agent asked them by their handle.
 */
export type SponsorAsked =
  | { readonly _tag: "Code"; readonly code: string }
  | { readonly _tag: "Consent" }
  | { readonly _tag: "List" };

export interface SponsorApproval {
  readonly agentId: AgentId;
  /** The person approving, who becomes the agent's sponsor. */
  readonly by: UserId;
  readonly asked: SponsorAsked;
  readonly idempotencyKey: string;
}

/** An agent's request to a person it named, or that person's answer to it. */
export interface PersonMove {
  readonly agentId: AgentId;
  /** The person asked, or answering. */
  readonly person: UserId;
  /** The run the agent asks in, from its token. A person names none. */
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
}

export interface SponsorEnding {
  readonly agentId: AgentId;
  /** The run an agent ends its own link in, from its token. A person names none. */
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
}

/**
 * The link between a person and an agent, which the agent's AgentSession DO
 * holds. It takes two: the agent asks and a person approves, so nobody
 * sponsors an agent that did not ask and no agent names a sponsor who did not
 * approve. It carries no rights and needs no org.
 *
 * - `ask`: one live request an agent, good once and for ten minutes; a new one
 *   replaces the last. An agent that already has a sponsor is refused
 *   (`sponsor-held`).
 * - `approve`: a missing, wrong, used or expired code is one answer,
 *   SponsorRequestRefused, whoever the agent is sponsored by. The same person
 *   approving again answers the agent as it stands.
 * - `end`: by the sponsor or by the agent itself, which the doorway decides.
 *   Ending the link while the agent is paused reinstates it. An agent's own
 *   end is committed in the run its token names.
 *
 * Each writes the agent's directory row before it answers. The same
 * Idempotency-Key and body answers the agent again; another body is an
 * IdempotencyConflict.
 */
export class Sponsorships extends Context.Service<
  Sponsorships,
  {
    readonly ask: (
      agentId: AgentId,
    ) => Effect.Effect<SponsorRequest, AgentNotKnown | AgentStateRefused>;
    readonly approve: (
      approval: SponsorApproval,
    ) => Effect.Effect<
      Agent,
      AgentNotKnown | AgentStateRefused | SponsorRequestRefused | IdempotencyConflict
    >;
    readonly end: (
      actor: Actor,
      ending: SponsorEnding,
    ) => Effect.Effect<Agent, AgentNotKnown | AgentStateRefused | IdempotencyConflict>;
    /**
     * The agent asks the person it named: a request on their own list for
     * seven days, told to every agent they sponsor. Asking again while it
     * waits answers the same request. Blocked, it is SponsorRequestRefused;
     * over the agent's or the person's limit, SponsorRequestsLimited.
     */
    readonly askPerson: (
      move: PersonMove,
    ) => Effect.Effect<
      { readonly person: UserId; readonly expiresAt: Instant },
      | AgentNotKnown
      | AgentStateRefused
      | SponsorRequestRefused
      | SponsorRequestsLimited
      | IdempotencyConflict
    >;
    /** The person declines the agent's waiting request, blocking it from asking again with `block`. */
    readonly decline: (
      move: PersonMove,
      block: boolean,
    ) => Effect.Effect<{ readonly blocked: boolean }, SponsorRequestRefused | IdempotencyConflict>;
    /** The person lets an agent they blocked ask them again. */
    readonly unblock: (
      move: PersonMove,
    ) => Effect.Effect<void, SponsorRequestRefused | IdempotencyConflict>;
  }
>()("keel/Sponsorships") {}
