import { Effect, Result, Schema } from "effect";
import {
  Agent,
  AgentEvent,
  type AgentKind,
  decideAgent,
  evolveAgent,
  IdempotencyConflict,
  type Scope,
} from "../../domain/identity/index.ts";
import type { AgentId, NamespaceId, ProjectId, UserId } from "../../domain/kernel/index.ts";
import {
  AgentDirectory,
  type Clock,
  commit,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  type Stored,
} from "../ports/index.ts";

/** Where the AgentSession DO keeps its agent, the source of truth the directory projects. */
export const AGENT = "agent";

/** An enrolment, as the isolate sends it: the client secret travels only as its hash. */
export interface EnrolAgent {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly kind: AgentKind;
  readonly scopes: readonly Scope[];
  /** The agent's org, when the enrolment names one. */
  readonly org?: NamespaceId | undefined;
  /** The user minting the credential, when the enrolment names one. */
  readonly sponsor?: UserId | undefined;
  readonly clientId: string;
  /** `sha256:` and the hex digest of the client secret. */
  readonly secretHash: string;
  readonly idempotencyKey: string;
  /** A hash of the enrolment without its secret, so a replay with a re-issued secret is the same command. */
  readonly fingerprint: string;
}

const decodeAgent = Schema.decodeUnknownSync(Agent);
const encodeAgent = Schema.encodeSync(Agent);
const encodeEvent = Schema.encodeSync(AgentEvent);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/**
 * Enrols the agent this AgentSession DO is for: commits AgentEnrolled through
 * the domain's Agent machine, then writes the AgentDirectory row before
 * answering, so the agent can exchange its credential at once. A replay with
 * the same key and body answers the same agent and writes the row again with
 * the replay's secret hash, which replaces the old one. A crash between the
 * commit and the row leaves the row to that retry.
 */
export const enrol: (
  agentId: AgentId,
  command: EnrolAgent,
) => Effect.Effect<Agent, IdempotencyConflict, Clock | EntityStore | EventOutbox | AgentDirectory> =
  Effect.fn("identity/enrol")(function* (agentId: AgentId, command: EnrolAgent) {
    const committed = yield* commit(
      {
        entity: { kind: "agent", id: agentId },
        cause: command.idempotencyKey,
        fingerprint: command.fingerprint,
        project: command.projectId,
      },
      (tx) => {
        const stored = tx.store.get(AGENT, agentId);
        const state = stored === undefined ? undefined : decodeAgent(stored);
        const decided = decideAgent(
          state,
          {
            _tag: "Enroll",
            projectId: command.projectId,
            name: command.name,
            kind: command.kind,
            scopes: command.scopes,
            ...(command.org === undefined ? {} : { org: command.org }),
            ...(command.sponsor === undefined ? {} : { sponsor: command.sponsor }),
          },
          { now: tx.at, agentId },
        );
        // The isolate derives the agent id from the key, so another key never names an enrolled agent.
        if (Result.isFailure(decided))
          throw new Error(`enrolling ${agentId} was refused`, { cause: decided.failure });
        let agent = state;
        const drafts: EventDraft[] = [];
        for (const payload of decided.success) {
          agent = evolveAgent(agent, { at: tx.at, payload });
          drafts.push({ payload: JSON.parse(JSON.stringify(encodeEvent(payload))) });
        }
        if (agent === undefined) throw new Error(`${agentId} has no state after enrolling`);
        tx.store.put(AGENT, agentId, asStored(encodeAgent(agent)));
        return Result.succeed({ value: agent, drafts });
      },
    );
    if (committed.duplicate && !committed.sameCommand)
      return yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
    const agent = committed.duplicate
      ? decodeAgent((yield* EntityStore).get(AGENT, agentId))
      : committed.value;
    yield* (yield* AgentDirectory).upsert(agent, {
      clientId: command.clientId,
      agentId,
      secretHash: command.secretHash,
    });
    return agent;
  });
