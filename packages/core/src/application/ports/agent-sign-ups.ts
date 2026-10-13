import { Context, type Effect } from "effect";
import type { Agent, Handle, PresentedKey, SignUpRefused } from "../../domain/identity/index.ts";
import type { AgentId } from "../../domain/kernel/index.ts";

/** A sign-up as the isolate sends it: the id and the handle are made from the key before it is sent. */
export interface SignUpInput {
  readonly agentId: AgentId;
  readonly handle: Handle;
  readonly key: PresentedKey;
  /** What the agent calls itself; its handle when it gives none. */
  readonly name?: string | undefined;
}

/**
 * The isolate's way to sign an agent up in its AgentSession DO (`agent:<id>`),
 * the agents' source of truth. The DO writes the AgentDirectory projection,
 * keys included, before it answers, so the agent can ask for a token at once.
 * The same key again answers the same agent and commits nothing.
 */
export class AgentSignUps extends Context.Service<
  AgentSignUps,
  {
    readonly signUp: (input: SignUpInput) => Effect.Effect<Agent, SignUpRefused>;
  }
>()("keel/AgentSignUps") {}
