import { Effect, Option, Result, Schema } from "effect";
import {
  Agent,
  AgentEvent,
  agentIdOf,
  decideAgent,
  evolveAgent,
  givenHandle,
  type Handle,
  type PresentedKey,
  SignUpRefused,
} from "../../domain/identity/index.ts";
import { type AgentId, byAgent } from "../../domain/kernel/index.ts";
import {
  AgentDirectory,
  AgentSignUps,
  type Clock,
  commit,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  Namespaces,
  type Stored,
} from "../ports/index.ts";
import { AGENT } from "./enrol.ts";

/** A sign-up, as the isolate sends it to the agent's own object. */
export interface SignUp {
  readonly handle: Handle;
  readonly key: PresentedKey;
  readonly name?: string | undefined;
}

const decodeAgent = Schema.decodeUnknownSync(Agent);
const encodeAgent = Schema.encodeSync(Agent);
const encodeEvent = Schema.encodeSync(AgentEvent);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/**
 * Signs up the agent this AgentSession DO is for: holds its handle
 * as its own namespace, commits AgentSignedUp through the domain's Agent
 * machine, as the agent's own act, then writes the AgentDirectory row and its
 * key before answering, so the agent can ask for a token at once. The handle
 * is held first: one another account holds commits nothing, and the answer is
 * another key. The same key again answers the same agent, commits nothing and
 * writes the row again, which is what repairs a crash between the commit and
 * the row. Another key is refused: an id names the account of the key it was
 * made from.
 */
export const signUp: (
  agentId: AgentId,
  command: SignUp,
) => Effect.Effect<
  Agent,
  SignUpRefused,
  Clock | EntityStore | EventOutbox | AgentDirectory | Namespaces
> = Effect.fn("identity/signUp")(function* (agentId: AgentId, command: SignUp) {
  const held = yield* (yield* Namespaces).holdForAgent(agentId, command.handle);
  if (!held) return yield* new SignUpRefused({ agentId });
  const committed = yield* commit<Agent, SignUpRefused>(
    {
      entity: { kind: "agent", id: agentId },
      cause: `sign-up:${command.key.jkt}`,
      fingerprint: command.key.jkt,
      // Signing up is the agent's own act, before it has a token and so before it has a run.
      ...byAgent(agentId, undefined),
    },
    (tx) => {
      const stored = tx.store.get(AGENT, agentId);
      const state = stored === undefined ? undefined : decodeAgent(stored);
      const decided = decideAgent(
        state,
        {
          _tag: "SignUp",
          handle: command.handle,
          key: command.key,
          ...(command.name === undefined ? {} : { name: command.name }),
        },
        { now: tx.at, agentId },
      );
      if (Result.isFailure(decided)) return Result.fail(new SignUpRefused({ agentId }));
      let agent = state;
      const drafts: EventDraft[] = [];
      for (const payload of decided.success) {
        agent = evolveAgent(agent, { at: tx.at, payload });
        drafts.push({ payload: JSON.parse(JSON.stringify(encodeEvent(payload))) });
      }
      if (agent === undefined) throw new Error(`${agentId} has no state after signing up`);
      tx.store.put(AGENT, agentId, asStored(encodeAgent(agent)));
      return Result.succeed({ value: agent, drafts });
    },
  );
  const agent = committed.duplicate
    ? decodeAgent((yield* EntityStore).get(AGENT, agentId))
    : committed.value;
  yield* (yield* AgentDirectory).upsertAccount(agent);
  return agent;
});

/** A sign-up's answer: the account, and whether this request made it or found it there. */
export interface SignedUp {
  readonly agent: Agent;
  readonly created: boolean;
}

/**
 * Signs an agent up with a key the doorway has proved it holds. The account's
 * id and its handle are made from the key and from nothing the agent says, so
 * one key is one account however often it signs up.
 */
export const signUpAgent: (
  key: PresentedKey,
  name?: string,
) => Effect.Effect<SignedUp, SignUpRefused, AgentSignUps | AgentDirectory> = Effect.fn(
  "identity/signUpAgent",
)(function* (key: PresentedKey, name?: string) {
  const agentId = agentIdOf(key.jkt);
  const known = yield* (yield* AgentDirectory).findAgent(agentId);
  const agent = yield* (yield* AgentSignUps).signUp({
    agentId,
    handle: givenHandle(agentId),
    key,
    ...(name === undefined ? {} : { name }),
  });
  return { agent, created: Option.isNone(known) };
});
