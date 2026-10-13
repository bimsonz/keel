import { Context, type Effect } from "effect";
import type {
  Actor,
  Agent,
  AgentNotKnown,
  AgentStateRefused,
  IdempotencyConflict,
} from "../../domain/identity/index.ts";
import type { AgentId } from "../../domain/kernel/index.ts";

/** A move on an agent's standing. A suspension says why; the others take no reason. */
export interface StandingInput {
  readonly agentId: AgentId;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

/**
 * An agent's standing, which its AgentSession DO holds: an actor the doorway
 * authorised suspends, reinstates or revokes it, recorded as
 * `user:<actor's id>`. Each writes the agent's directory row before it
 * answers, so the agent's next request is judged by its new standing. The
 * same Idempotency-Key and body answers the agent again; another body is an
 * IdempotencyConflict. A move the agent's state refuses (reinstating an
 * active agent, anything after a revocation) is AgentStateRefused.
 */
export class Standings extends Context.Service<
  Standings,
  {
    readonly suspend: (
      actor: Actor,
      input: StandingInput,
    ) => Effect.Effect<Agent, AgentNotKnown | AgentStateRefused | IdempotencyConflict>;
    readonly reinstate: (
      actor: Actor,
      input: StandingInput,
    ) => Effect.Effect<Agent, AgentNotKnown | AgentStateRefused | IdempotencyConflict>;
    readonly revoke: (
      actor: Actor,
      input: StandingInput,
    ) => Effect.Effect<Agent, AgentNotKnown | AgentStateRefused | IdempotencyConflict>;
  }
>()("keel/Standings") {}
