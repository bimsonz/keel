import {
  type Agent,
  type AgentCommand,
  AgentNotKnown,
  AgentStateRefused,
  decideAgent,
  eventActorOf,
  evolveAgent,
  IdempotencyConflict,
  SPONSOR_ASKS_PER_WINDOW,
  SPONSOR_ASKS_WINDOW_MS,
  SPONSOR_REQUEST_MS,
  SPONSOR_REQUESTS_PER_PERSON,
  SponsorRequestRefused,
  SponsorRequestsLimited,
} from "@keeltown/core/domain/identity";
import { type AgentId, Instant, type UserId } from "@keeltown/core/kernel";
import {
  AgentDirectory,
  type SponsorRequestRow,
  SponsorRequests,
  Sponsorships,
} from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Result } from "effect";
import { nextAgentSeq } from "./standings.ts";

/** As the AgentSession DO's: how long an agent's request for a sponsor stays good. */
const ASK_MS = 10 * 60_000;

/**
 * Sponsorships over an AgentDirectory, with the AgentSession DO's rules: one
 * live request an agent, good once; the domain's Agent machine decides each
 * move on the agent as the directory holds it; the directory's sponsor (and
 * its standing, when ending the link reinstates the agent) is written with the
 * move's seq; and a key replayed with its body answers the agent as it stands.
 * `expire` is the suite's way to let a request run out. Requests to people
 * named by handle are kept as the D1 rows a person's list reads, and the same
 * layer serves those rows as `SponsorRequests`.
 */
const rowKey = (agentId: AgentId, person: UserId) => `${agentId} ${person}`;
const waits = (row: SponsorRequestRow | undefined, now: number) =>
  row?.expiresAt !== undefined && row.expiresAt > now;

/**
 * SponsorRequests over a map: the rows a person's list reads, one an agent
 * and a person, each write guarded by the agent's event number as D1's is.
 */
export function makeSponsorRequestsMemory() {
  const rows = new Map<string, SponsorRequestRow>();
  const seqs = new Map<string, number>();
  const requests = SponsorRequests.of({
    apply: (row, seq) =>
      Effect.sync(() => {
        const key = rowKey(row.agentId, row.person);
        if ((seqs.get(key) ?? -1) >= seq) return;
        seqs.set(key, seq);
        rows.set(key, row);
      }),
    settle: (agentId) =>
      Effect.sync(() => {
        for (const [key, row] of rows)
          if (row.agentId === agentId)
            rows.set(key, {
              agentId,
              person: row.person,
              ...(row.blockedAt === undefined ? {} : { blockedAt: row.blockedAt }),
            });
      }),
    waitingFor: (person, now) =>
      Effect.sync(() =>
        [...rows.values()]
          .filter((row) => row.person === person && waits(row, now))
          .toSorted((x, y) => (x.askedAt ?? 0) - (y.askedAt ?? 0)),
      ),
    waitingCount: (person, now) =>
      Effect.sync(
        () => [...rows.values()].filter((row) => row.person === person && waits(row, now)).length,
      ),
    blockedBy: (person) =>
      Effect.sync(() =>
        [...rows.values()]
          .filter((row) => row.person === person && row.blockedAt !== undefined)
          .toSorted((x, y) => (x.blockedAt ?? 0) - (y.blockedAt ?? 0)),
      ),
  });
  return { rows, requests, layer: Layer.succeed(SponsorRequests, requests) };
}

export function makeSponsorshipsMemory() {
  const asks = new Map<AgentId, { readonly code: string; readonly expiresAt: number }>();
  const byKey = new Map<string, string>();
  const { rows, requests } = makeSponsorRequestsMemory();
  const askTimes = new Map<AgentId, number[]>();
  return {
    expire: (agentId: AgentId) =>
      Effect.sync(() => {
        const ask = asks.get(agentId);
        if (ask !== undefined) asks.set(agentId, { ...ask, expiresAt: 0 });
      }),
    layer: Layer.effect(
      Sponsorships,
      Effect.gen(function* () {
        const directory = yield* AgentDirectory;
        const move = (
          agentId: AgentId,
          key: string,
          body: string,
          idempotencyKey: string,
          command: AgentCommand,
          admit: (now: number) => boolean,
        ) =>
          Effect.gen(function* () {
            const now = Instant(yield* EffectClock.currentTimeMillis);
            const found = yield* directory.findAgent(agentId);
            const replayed = byKey.get(key);
            if (replayed !== undefined) {
              if (replayed !== body) return yield* new IdempotencyConflict({ idempotencyKey });
              if (Option.isSome(found)) return found.value;
            }
            if (Option.isNone(found)) return yield* new AgentNotKnown({ agentId });
            if (!admit(now)) return yield* new SponsorRequestRefused({ agentId });
            const decided = decideAgent(found.value, command, { now, agentId });
            if (Result.isFailure(decided)) return yield* decided.failure;
            let agent: Agent = found.value;
            for (const payload of decided.success) agent = evolveAgent(agent, { at: now, payload });
            if (decided.success.length > 0) {
              asks.delete(agentId);
              if (agent.sponsor !== undefined) yield* requests.settle(agentId);
              yield* directory.sponsor(agentId, agent.sponsor ?? null, nextAgentSeq());
              if (agent.state !== found.value.state)
                yield* directory.standing(agentId, { state: agent.state }, nextAgentSeq());
            }
            byKey.set(key, body);
            return agent;
          });
        return Sponsorships.of({
          ask: (agentId) =>
            Effect.gen(function* () {
              const now = yield* EffectClock.currentTimeMillis;
              const found = yield* directory.findAgent(agentId);
              if (Option.isNone(found)) return yield* new AgentNotKnown({ agentId });
              const { state, sponsor } = found.value;
              if (state === "revoked" || sponsor !== undefined)
                return yield* new AgentStateRefused({
                  agentId,
                  state,
                  command: "Sponsor",
                  ...(state === "revoked" ? {} : { reason: "sponsor-held" as const }),
                });
              const code = crypto.randomUUID();
              const expiresAt = Instant(now + ASK_MS);
              asks.set(agentId, { code, expiresAt });
              return { code, expiresAt };
            }),
          approve: ({ agentId, by, asked, idempotencyKey }) =>
            move(
              agentId,
              `${agentId} sponsor ${idempotencyKey}`,
              JSON.stringify([by, asked]),
              idempotencyKey,
              { _tag: "Sponsor", by },
              (now) => {
                if (asked._tag === "Consent") return true;
                if (asked._tag === "List") return waits(rows.get(rowKey(agentId, by)), now);
                const ask = asks.get(agentId);
                return ask !== undefined && ask.code === asked.code && ask.expiresAt > now;
              },
            ),
          end: (actor, { agentId, idempotencyKey }) =>
            move(
              agentId,
              `${agentId} unsponsor ${idempotencyKey}`,
              JSON.stringify([eventActorOf(actor)]),
              idempotencyKey,
              { _tag: "EndSponsorship", by: eventActorOf(actor) },
              () => true,
            ).pipe(Effect.catchTag("SponsorRequestRefused", (refusal) => Effect.die(refusal))),
          askPerson: ({ agentId, person }) =>
            Effect.gen(function* () {
              const now = yield* EffectClock.currentTimeMillis;
              const found = yield* directory.findAgent(agentId);
              if (Option.isNone(found)) return yield* new AgentNotKnown({ agentId });
              const { state, sponsor } = found.value;
              if (state === "revoked" || sponsor !== undefined)
                return yield* new AgentStateRefused({
                  agentId,
                  state,
                  command: "Sponsor",
                  ...(state === "revoked" ? {} : { reason: "sponsor-held" as const }),
                });
              const row = rows.get(rowKey(agentId, person));
              if (row?.expiresAt !== undefined && waits(row, now))
                return { person, expiresAt: row.expiresAt };
              if (row?.blockedAt !== undefined)
                return yield* new SponsorRequestRefused({ agentId });
              const times = (askTimes.get(agentId) ?? []).filter(
                (at) => at > now - SPONSOR_ASKS_WINDOW_MS,
              );
              if (times.length >= SPONSOR_ASKS_PER_WINDOW)
                return yield* new SponsorRequestsLimited({
                  agentId,
                  retryAfterMs: Math.max(1, (times[0] ?? now) + SPONSOR_ASKS_WINDOW_MS - now),
                });
              if (
                (yield* requests.waitingCount(person, Instant(now))) >= SPONSOR_REQUESTS_PER_PERSON
              )
                return yield* new SponsorRequestsLimited({
                  agentId,
                  retryAfterMs: SPONSOR_ASKS_WINDOW_MS,
                });
              const expiresAt = Instant(now + SPONSOR_REQUEST_MS);
              rows.set(rowKey(agentId, person), {
                agentId,
                person,
                askedAt: Instant(now),
                expiresAt,
              });
              askTimes.set(agentId, [...times, now]);
              return { person, expiresAt };
            }),
          decline: ({ agentId, person }, block) =>
            Effect.gen(function* () {
              const now = yield* EffectClock.currentTimeMillis;
              const row = rows.get(rowKey(agentId, person));
              if (!waits(row, now)) return yield* new SponsorRequestRefused({ agentId });
              const blockedAt = block ? Instant(now) : row?.blockedAt;
              rows.set(rowKey(agentId, person), {
                agentId,
                person,
                ...(blockedAt === undefined ? {} : { blockedAt }),
              });
              return { blocked: blockedAt !== undefined };
            }),
          unblock: ({ agentId, person }) =>
            Effect.gen(function* () {
              const row = rows.get(rowKey(agentId, person));
              if (row?.blockedAt === undefined)
                return yield* new SponsorRequestRefused({ agentId });
              const { blockedAt: _, ...rest } = row;
              rows.set(rowKey(agentId, person), rest);
              return undefined;
            }),
        });
      }),
    ).pipe(Layer.merge(Layer.succeed(SponsorRequests, requests))),
  };
}
