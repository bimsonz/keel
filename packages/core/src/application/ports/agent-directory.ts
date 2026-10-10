import { Context, type Effect, type Option } from "effect";
import type { Agent } from "../../domain/identity/index.ts";
import type { AgentId } from "../../domain/kernel/index.ts";

/** A client credential as stored: never the secret itself, only its hash. */
export interface StoredCredential {
  readonly clientId: string;
  readonly agentId: AgentId;
  /** `sha256:` and the hex digest of the secret. */
  readonly secretHash: string;
}

/**
 * Agents, their client credentials and scopes, and their revocation epochs.
 * A read model: the AgentSession DO is the source of truth and projects here.
 */
export class AgentDirectory extends Context.Service<AgentDirectory, {
  readonly findAgent: (agentId: AgentId) => Effect.Effect<Option.Option<Agent>>;
  readonly findCredential: (clientId: string) => Effect.Effect<Option.Option<StoredCredential>>;
  /**
   * The agent a client credential belongs to, if `secret` is its secret. The
   * adapter hashes and compares in constant time, so the secret never leaves it.
   */
  readonly verifyCredential: (clientId: string, secret: string) => Effect.Effect<Option.Option<AgentId>>;
  /** Writes the projection of an agent and its credential. */
  readonly upsert: (agent: Agent, credential: StoredCredential) => Effect.Effect<void>;
}>()("keel/AgentDirectory") {}
