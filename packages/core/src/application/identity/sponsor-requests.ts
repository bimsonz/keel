import { Effect, Result, Schema } from "effect";
import {
  Agent,
  AgentNotKnown,
  AgentStateRefused,
  decideSponsorRequest,
  evolvePersonAsked,
  IdempotencyConflict,
  PersonAsked,
  SPONSOR_ASKS_PER_WINDOW,
  SPONSOR_ASKS_WINDOW_MS,
  SPONSOR_REQUESTS_PER_PERSON,
  type SponsorRequestCommand,
  SponsorRequestEvent,
  SponsorRequestRefused,
  SponsorRequestsLimited,
  waiting,
} from "../../domain/identity/index.ts";
import {
  type AgentId,
  byAgent,
  type CommandActor,
  type EntityRef,
  type Instant,
  type RunRef,
  type UserId,
  userActor,
} from "../../domain/kernel/index.ts";
import {
  AgentDirectory,
  Clock,
  commit,
  EntityStore,
  type EventDraft,
  type EventOutbox,
  SponsorRequests,
  type Stored,
} from "../ports/index.ts";
import { AGENT } from "./enrol.ts";
import { hearEvent } from "./session.ts";

/** An agent's requests to one person, one row a person, in the agent's own object. */
export const PERSON_ASKED = "person-asked";

/** When the agent asked people, oldest first, within the last window: what its hourly limit counts. */
export const ASKED_AT = "sponsor-asked-at";

const decodeAgent = Schema.decodeUnknownSync(Agent);
const decodeAsked = Schema.decodeUnknownSync(PersonAsked);
const encodeAsked = Schema.encodeSync(PersonAsked);
const encodeEvent = Schema.encodeSync(SponsorRequestEvent);
const decodeTimes = Schema.decodeUnknownSync(Schema.Array(Schema.Int));
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/** An agent's request to a person, as the isolate sends it once it has found the person by their handle. */
export interface AskPerson {
  readonly person: UserId;
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/** A person's answer to an agent's request, or their unblock of it. */
export interface AnswerRequest {
  readonly person: UserId;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/** What the agent is told of its request to a person: whom, and until when it waits. */
export interface PersonRequest {
  readonly person: UserId;
  readonly expiresAt: Instant;
}

const askedOf = (
  store: (typeof EntityStore)["Service"],
  person: UserId,
): PersonAsked | undefined => {
  const stored = store.get(PERSON_ASKED, person);
  return stored === undefined ? undefined : decodeAsked(stored);
};

/**
 * Commits one command on the agent's requests to `person` through the
 * domain's decision, on the agent's own entity, then writes the person's row
 * before answering, guarded by the event's seq. A refusal is the domain's.
 */
const moveRequest = Effect.fn("identity/moveRequest")(function* (
  agentId: AgentId,
  person: UserId,
  spec: {
    readonly cause: string;
    readonly fingerprint: string;
    readonly actor: CommandActor;
    readonly run?: RunRef | undefined;
  },
  idempotencyKey: string,
  command: SponsorRequestCommand,
  extra: { readonly affected?: readonly EntityRef[]; readonly tells?: readonly AgentId[] } = {},
) {
  const committed = yield* commit(
    {
      entity: { kind: "agent", id: agentId },
      cause: spec.cause,
      fingerprint: spec.fingerprint,
      actor: spec.actor,
      ...(spec.run === undefined ? {} : { run: spec.run }),
    },
    (tx) => {
      const asked = askedOf(tx.store, person);
      const decided = decideSponsorRequest(asked, command, { agentId, person });
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      let next = asked;
      const drafts: EventDraft[] = [];
      for (const event of decided.success) {
        next = evolvePersonAsked(next, event, tx.at);
        drafts.push({
          payload: JSON.parse(JSON.stringify(encodeEvent(event))),
          affected: [{ kind: "user", id: person }, ...(extra.affected ?? [])],
        });
      }
      if (next !== undefined) tx.store.put(PERSON_ASKED, person, asStored(encodeAsked(next)));
      // Each agent the person sponsors hears of a request to them, and of no other.
      if (decided.success.some((event) => event._tag === "SponsorRequested"))
        for (const told of extra.tells ?? [])
          tx.outbox.subscribe(`agent:${told}`, ["SponsorRequested"], { kind: "agent", id: told });
      return Result.succeed({ value: next, drafts });
    },
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey });
  const store = yield* EntityStore;
  const now = committed.duplicate ? undefined : committed.value;
  const settled = now ?? askedOf(store, person);
  const last = committed.events.at(-1);
  if (last !== undefined)
    yield* (yield* SponsorRequests).apply(
      {
        agentId,
        person,
        ...(settled?.expiresAt === undefined
          ? {}
          : { askedAt: last.at, expiresAt: settled.expiresAt }),
        ...(settled?.blockedAt === undefined ? {} : { blockedAt: settled.blockedAt }),
      },
      last.seq,
    );
  return { settled, events: committed.events };
});

/**
 * The agent this AgentSession DO is for asks `person` to sponsor it,
 * idempotent by `ask-person:<key>`. An agent somebody already sponsors is
 * refused as `askSponsor` refuses it. Asking again while a request waits
 * answers that request and counts for nothing; a person who blocked the agent
 * is refused as if they were not there. The agent's own limit
 * (`SPONSOR_ASKS_PER_WINDOW` an hour) and the person's
 * (`SPONSOR_REQUESTS_PER_PERSON` waiting) are SponsorRequestsLimited. Every
 * agent the person sponsors is told.
 */
export const askPerson: (
  agentId: AgentId,
  command: AskPerson,
) => Effect.Effect<
  PersonRequest,
  | AgentNotKnown
  | AgentStateRefused
  | SponsorRequestRefused
  | SponsorRequestsLimited
  | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | AgentDirectory | SponsorRequests
> = Effect.fn("identity/askPerson")(function* (agentId: AgentId, command: AskPerson) {
  const now = yield* (yield* Clock).now;
  const store = yield* EntityStore;
  const stored = store.get(AGENT, agentId);
  if (stored === undefined) return yield* new AgentNotKnown({ agentId });
  const agent = decodeAgent(stored);
  if (agent.state === "revoked")
    return yield* new AgentStateRefused({ agentId, state: agent.state, command: "Sponsor" });
  if (agent.sponsor !== undefined)
    return yield* new AgentStateRefused({
      agentId,
      state: agent.state,
      command: "Sponsor",
      reason: "sponsor-held",
    });
  const asked = askedOf(store, command.person);
  if (asked?.expiresAt !== undefined && waiting(asked, now))
    return { person: command.person, expiresAt: asked.expiresAt };
  if (asked?.blockedAt !== undefined) return yield* new SponsorRequestRefused({ agentId });
  const times = decodeTimes(store.get(ASKED_AT, agentId) ?? []).filter(
    (at) => at > now - SPONSOR_ASKS_WINDOW_MS,
  );
  if (times.length >= SPONSOR_ASKS_PER_WINDOW)
    return yield* new SponsorRequestsLimited({
      agentId,
      retryAfterMs: Math.max(1, (times[0] ?? now) + SPONSOR_ASKS_WINDOW_MS - now),
    });
  const requests = yield* SponsorRequests;
  if ((yield* requests.waitingCount(command.person, now)) >= SPONSOR_REQUESTS_PER_PERSON)
    return yield* new SponsorRequestsLimited({ agentId, retryAfterMs: SPONSOR_ASKS_WINDOW_MS });
  const sponsored = yield* (yield* AgentDirectory).sponsoredBy(command.person);
  const tells = sponsored.map((other) => other.id).filter((id) => id !== agentId);
  const { settled } = yield* moveRequest(
    agentId,
    command.person,
    {
      cause: `ask-person:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      ...byAgent(agentId, command.run),
    },
    command.idempotencyKey,
    { _tag: "Ask", now },
    { affected: tells.map((id) => ({ kind: "agent" as const, id })), tells },
  );
  store.put(ASKED_AT, agentId, asStored([...times, now]));
  if (settled?.expiresAt === undefined) return yield* new SponsorRequestRefused({ agentId });
  return { person: command.person, expiresAt: settled.expiresAt };
});

/**
 * The person the agent asked declines its request, idempotent by
 * `decline:<key>`; with `block`, the agent may not ask them again until they
 * unblock it. No request waiting for that person is SponsorRequestRefused.
 * The agent is told in its own inbox.
 */
export const declinePerson: (
  agentId: AgentId,
  command: AnswerRequest & { readonly block: boolean },
) => Effect.Effect<
  { readonly blocked: boolean },
  SponsorRequestRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | SponsorRequests
> = Effect.fn("identity/declinePerson")(function* (
  agentId: AgentId,
  command: AnswerRequest & { readonly block: boolean },
) {
  const now = yield* (yield* Clock).now;
  const { settled, events } = yield* moveRequest(
    agentId,
    command.person,
    {
      cause: `decline:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: userActor(command.person),
    },
    command.idempotencyKey,
    { _tag: "Decline", block: command.block, now },
  );
  const store = yield* EntityStore;
  store.transaction(() => {
    for (const event of events) hearEvent(store, agentId, event);
  });
  return { blocked: settled?.blockedAt !== undefined };
});

/**
 * The person lets an agent they blocked ask them again, idempotent by
 * `unblock:<key>`. An agent they have not blocked is SponsorRequestRefused.
 * The agent is not told: it learns of it only by asking.
 */
export const unblockPerson: (
  agentId: AgentId,
  command: AnswerRequest,
) => Effect.Effect<
  void,
  SponsorRequestRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | SponsorRequests
> = Effect.fn("identity/unblockPerson")(function* (agentId: AgentId, command: AnswerRequest) {
  yield* moveRequest(
    agentId,
    command.person,
    {
      cause: `unblock:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: userActor(command.person),
    },
    command.idempotencyKey,
    { _tag: "Unblock" },
  );
});

/** Whether a request from the agent waits for `person` at `at`: what an approval from that person's own list needs. */
export const requestWaits = (
  store: (typeof EntityStore)["Service"],
  person: UserId,
  at: Instant,
): boolean => waiting(askedOf(store, person), at);

/**
 * Ends every request the agent has waiting, inside the transaction that made
 * somebody its sponsor: none of them can be approved any more.
 */
export function settleRequests(store: (typeof EntityStore)["Service"]): void {
  for (const row of store.list(PERSON_ASKED)) {
    const { expiresAt, ...rest } = decodeAsked(row.value);
    if (expiresAt !== undefined) store.put(PERSON_ASKED, row.id, asStored(encodeAsked(rest)));
  }
}
