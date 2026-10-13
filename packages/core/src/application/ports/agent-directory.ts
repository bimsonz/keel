import { Context, type Effect, type Option } from "effect";
import type { Agent, AgentState } from "../../domain/identity/index.ts";
import type { AgentId, UserId } from "../../domain/kernel/index.ts";

/** A client credential as stored: never the secret itself, only its hash. */
export interface StoredCredential {
  readonly clientId: string;
  readonly agentId: AgentId;
  /** `sha256:` and the hex digest of the secret. */
  readonly secretHash: string;
}

/**
 * An agent's standing as one of its events leaves it. Only a revocation moves
 * the epoch, so a suspension or reinstatement carries none and the row keeps
 * its own.
 */
export interface AgentStanding {
  readonly state: AgentState;
  readonly revocationEpoch?: number;
}

/**
 * Agents, their client credentials and scopes, and their revocation epochs.
 * A read model: the AgentSession DO is the source of truth and projects here.
 */
export class AgentDirectory extends Context.Service<
  AgentDirectory,
  {
    readonly findAgent: (agentId: AgentId) => Effect.Effect<Option.Option<Agent>>;
    readonly findCredential: (clientId: string) => Effect.Effect<Option.Option<StoredCredential>>;
    /**
     * The agent a client credential belongs to, if `secret` is its secret. The
     * adapter hashes and compares in constant time, so the secret never leaves it.
     */
    readonly verifyCredential: (
      clientId: string,
      secret: string,
    ) => Effect.Effect<Option.Option<AgentId>>;
    /** Writes the projection of an agent and its credential. Its standing's seq is left alone. */
    readonly upsert: (agent: Agent, credential: StoredCredential) => Effect.Effect<void>;
    /**
     * Writes an agent's standing as the event at `seq` on its entity left it,
     * only if the row last took an earlier one: a late or repeated write (the
     * Projector's repair after the inline write) never moves it back. An
     * unknown agent is left alone.
     */
    readonly standing: (
      agentId: AgentId,
      standing: AgentStanding,
      seq: number,
    ) => Effect.Effect<void>;
    /**
     * Writes who sponsors an agent, or that nobody does (`null`), as the event
     * at `seq` on its entity left it, guarded as `standing` is. Once written,
     * `upsert` no longer touches the row's sponsor.
     */
    readonly sponsor: (
      agentId: AgentId,
      sponsor: UserId | null,
      seq: number,
    ) => Effect.Effect<void>;
    /** The agents a person sponsors, oldest first: what the person's own page lists. */
    readonly sponsoredBy: (userId: UserId) => Effect.Effect<readonly Agent[]>;
  }
>()("keel/AgentDirectory") {}
