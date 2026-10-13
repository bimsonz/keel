import { Effect, Result, Schema } from "effect";
import {
  Agent,
  type AgentCommand,
  AgentEvent,
  AgentNotKnown,
  AgentStateRefused,
  decideAgent,
  evolveAgent,
  IdempotencyConflict,
  SponsorRequestRefused,
} from "../../domain/identity/index.ts";
import {
  type AgentId,
  type CommandActor as EventActor,
  Instant,
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
  type Stored,
  type Transaction,
} from "../ports/index.ts";
import { AGENT } from "./enrol.ts";
import { hearEvent } from "./session.ts";
import { sponsorOf, standingOf, withoutNamespace } from "./standing.ts";

/** An agent's live request for a sponsor, one row an agent: its code's hash and when it stops being good. */
export const SPONSOR_ASK = "sponsor-ask";

/** How long an agent's request for a sponsor stays good. */
export const SPONSOR_ASK_MS = 10 * 60_000;

/**
 * Whether two hashes are the same, in time that depends on their length alone.
 * The comparison never stops at the first difference, so how long a wrong code
 * took to refuse says nothing about how much of it was right.
 */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

const Ask = Schema.Struct({ codeHash: Schema.NonEmptyString, expiresAt: Schema.Int });

const decodeAgent = Schema.decodeUnknownSync(Agent);
const encodeAgent = Schema.encodeSync(Agent);
const encodeEvent = Schema.encodeSync(AgentEvent);
const decodeAsk = Schema.decodeUnknownSync(Ask);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/**
 * The agent this AgentSession DO is for asks for a sponsor. The isolate minted
 * the code and sends only its hash, as it does a client secret. One request an
 * agent: a new one replaces the last. It commits no event, since nothing about
 * the agent has changed yet. An agent somebody already stands behind is
 * refused (`sponsor-held`), so no code is ever given that could not be used.
 */
export const askSponsor: (
  agentId: AgentId,
  codeHash: string,
) => Effect.Effect<Instant, AgentNotKnown | AgentStateRefused, Clock | EntityStore> = Effect.fn(
  "identity/askSponsor",
)(function* (agentId: AgentId, codeHash: string) {
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
  const expiresAt = Instant(now + SPONSOR_ASK_MS);
  store.put(SPONSOR_ASK, agentId, asStored({ codeHash, expiresAt }));
  return expiresAt;
});

/** A person's approval, as the isolate sends it. */
export interface ApproveSponsor {
  readonly by: UserId;
  /**
   * The hash of the code the person presented. Absent only from the OAuth
   * provider's consent flow, where the agent's ask is the authorization
   * request its own tool made.
   */
  readonly codeHash?: string | undefined;
  readonly idempotencyKey: string;
  /** A hash of the request, so a reused key is told apart from a retry. */
  readonly fingerprint: string;
}

/** The link's end, as the isolate sends it: `by` is the sponsor or the agent itself, `run` the run an agent ends it in. */
export interface EndSponsor {
  readonly by: EventActor;
  readonly run?: RunRef | undefined;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

type LinkRefusal = AgentNotKnown | AgentStateRefused | SponsorRequestRefused;

/**
 * Commits one move on the sponsor link through the domain's Agent machine,
 * then writes the directory row (the sponsor, and the standing when ending
 * the link reinstated the agent) before answering, each guarded by its
 * event's seq; the Projector repeats the writes on delivery. The agent is
 * told, in its own inbox, of a move somebody else made. The answer names no
 * namespace (`withoutNamespace`).
 */
const moveLink = Effect.fn("identity/moveLink")(function* (
  agentId: AgentId,
  spec: {
    readonly cause: string;
    readonly fingerprint: string;
    readonly actor: EventActor;
    readonly run?: RunRef | undefined;
  },
  idempotencyKey: string,
  command: AgentCommand,
  admit: (tx: Transaction) => SponsorRequestRefused | undefined,
  settle: (tx: Transaction, events: readonly AgentEvent[]) => void,
) {
  const store = yield* EntityStore;
  const stored = store.get(AGENT, agentId);
  const project = stored === undefined ? undefined : decodeAgent(stored).projectId;
  const committed = yield* commit(
    {
      entity: { kind: "agent", id: agentId },
      cause: spec.cause,
      fingerprint: spec.fingerprint,
      actor: spec.actor,
      ...(spec.run === undefined ? {} : { run: spec.run }),
      ...(project === undefined ? {} : { project }),
    },
    (tx) => {
      const current = tx.store.get(AGENT, agentId);
      if (current === undefined) return Result.fail<LinkRefusal>(new AgentNotKnown({ agentId }));
      const refused = admit(tx);
      if (refused !== undefined) return Result.fail<LinkRefusal>(refused);
      const decided = decideAgent(decodeAgent(current), command, { now: tx.at, agentId });
      if (Result.isFailure(decided)) return Result.fail<LinkRefusal>(decided.failure);
      let agent = decodeAgent(current);
      const drafts: EventDraft[] = [];
      for (const payload of decided.success) {
        agent = evolveAgent(agent, { at: tx.at, payload });
        drafts.push({
          payload: JSON.parse(JSON.stringify(encodeEvent(payload))),
          ...(payload._tag === "AgentSponsored" || payload._tag === "AgentUnsponsored"
            ? { affected: [{ kind: "user" as const, id: payload.sponsor }] }
            : {}),
        });
      }
      tx.store.put(AGENT, agentId, asStored(encodeAgent(agent)));
      settle(tx, decided.success);
      return Result.succeed({ value: agent, drafts });
    },
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey });
  const directory = yield* AgentDirectory;
  for (const event of committed.events) {
    const linked = sponsorOf(event);
    if (linked !== undefined) yield* directory.sponsor(linked.agentId, linked.sponsor, linked.seq);
    const moved = standingOf(event);
    if (moved !== undefined) yield* directory.standing(moved.agentId, moved.standing, moved.seq);
  }
  if (committed.duplicate) return withoutNamespace(decodeAgent(store.get(AGENT, agentId)));
  store.transaction(() => {
    for (const event of committed.events) hearEvent(store, agentId, event);
  });
  return withoutNamespace(committed.value);
});

/**
 * A person becomes the sponsor of the agent this AgentSession DO is for,
 * idempotent by `sponsor:<key>`. With a code, the agent's live request must
 * hold that code's hash and not have expired, whatever else is true of the
 * agent: every other case is SponsorRequestRefused. The request is spent by
 * the approval that commits, so a code is good once.
 */
export const approveSponsor: (
  agentId: AgentId,
  command: ApproveSponsor,
) => Effect.Effect<
  Agent,
  LinkRefusal | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | AgentDirectory
> = (agentId, command) =>
  moveLink(
    agentId,
    {
      cause: `sponsor:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: userActor(command.by),
    },
    command.idempotencyKey,
    { _tag: "Sponsor", by: command.by },
    (tx) => {
      if (command.codeHash === undefined) return undefined;
      const stored = tx.store.get(SPONSOR_ASK, agentId);
      const ask = stored === undefined ? undefined : decodeAsk(stored);
      return ask !== undefined && sameHash(ask.codeHash, command.codeHash) && ask.expiresAt > tx.at
        ? undefined
        : new SponsorRequestRefused({ agentId });
    },
    (tx, events) => {
      if (events.length > 0) tx.store.remove(SPONSOR_ASK, agentId);
    },
  );

/**
 * Ends the sponsor link of the agent this AgentSession DO is for, idempotent
 * by `unsponsor:<key>`. A paused agent is reinstated in the same commit.
 */
export const endSponsorship: (
  agentId: AgentId,
  command: EndSponsor,
) => Effect.Effect<
  Agent,
  AgentNotKnown | AgentStateRefused | IdempotencyConflict,
  Clock | EntityStore | EventOutbox | AgentDirectory
> = (agentId, command) =>
  moveLink(
    agentId,
    {
      cause: `unsponsor:${command.idempotencyKey}`,
      fingerprint: command.fingerprint,
      actor: command.by,
      ...(command.run === undefined ? {} : { run: command.run }),
    },
    command.idempotencyKey,
    { _tag: "EndSponsorship", by: command.by },
    () => undefined,
    () => undefined,
  ).pipe(
    // Ending a link presents no code, so its request is never the refusal.
    Effect.catchTag("SponsorRequestRefused", (refusal) => Effect.die(refusal)),
  );
