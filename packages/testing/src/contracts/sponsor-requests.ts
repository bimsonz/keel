import { describe, expect, it } from "@effect/vitest";
import { AgentId, Instant, UserId } from "@keeltown/core/kernel";
import { SponsorRequests } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const anAgent = () => Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`);
const aPerson = () => Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);

/** The agents a person's list shows, and how many it counts, at `now`. */
const listed = (person: UserId, now: number) =>
  Effect.gen(function* () {
    const requests = yield* SponsorRequests;
    const rows = yield* requests.waitingFor(person, Instant(now));
    return {
      agents: rows.map((row) => row.agentId),
      count: yield* requests.waitingCount(person, Instant(now)),
    };
  });

/**
 * The rows a person's list of sponsor requests reads: one an agent and a
 * person, written with the agent's event number and never moved back by a
 * lower one; a request waits while its end is later than now; a sponsor ends
 * every request the agent has waiting, and leaves a block as it was.
 */
export function describeSponsorRequestsContract(
  adapter: string,
  make: () => Layer.Layer<SponsorRequests>,
) {
  describe(`SponsorRequests contract: ${adapter}`, () => {
    it.effect(
      "[sponsorrequests.contract] a person's list shows the requests waiting for them, oldest first, and counts them; one past its end is in neither",
      () =>
        Effect.gen(function* () {
          const requests = yield* SponsorRequests;
          const person = aPerson();
          const [first, second, lapsed] = [anAgent(), anAgent(), anAgent()];
          yield* requests.apply(
            { agentId: second, person, askedAt: Instant(2_000), expiresAt: Instant(90_000) },
            1,
          );
          yield* requests.apply(
            { agentId: first, person, askedAt: Instant(1_000), expiresAt: Instant(90_000) },
            1,
          );
          yield* requests.apply(
            { agentId: lapsed, person, askedAt: Instant(500), expiresAt: Instant(5_000) },
            1,
          );
          expect(yield* listed(person, 10_000)).toEqual({ agents: [first, second], count: 2 });
          expect(yield* listed(aPerson(), 10_000)).toEqual({ agents: [], count: 0 });
        }).pipe(Effect.provide(make())),
    );

    it.effect(
      "[sponsorrequests.contract] a write at or below the row's own event number changes nothing; a later one replaces it",
      () =>
        Effect.gen(function* () {
          const requests = yield* SponsorRequests;
          const [person, agentId] = [aPerson(), anAgent()];
          yield* requests.apply(
            { agentId, person, askedAt: Instant(1_000), expiresAt: Instant(90_000) },
            3,
          );
          yield* requests.apply({ agentId, person }, 3);
          yield* requests.apply({ agentId, person }, 2);
          expect(yield* listed(person, 10_000)).toEqual({ agents: [agentId], count: 1 });
          yield* requests.apply({ agentId, person, blockedAt: Instant(4_000) }, 4);
          expect(yield* listed(person, 10_000)).toEqual({ agents: [], count: 0 });
          expect((yield* requests.blockedBy(person)).map((row) => row.agentId)).toEqual([agentId]);
        }).pipe(Effect.provide(make())),
    );

    it.effect(
      "[sponsorrequests.contract] a sponsor ends every request the agent has waiting, to anyone, and leaves its blocks as they were",
      () =>
        Effect.gen(function* () {
          const requests = yield* SponsorRequests;
          const [pat, sam, blocker, agentId] = [aPerson(), aPerson(), aPerson(), anAgent()];
          for (const person of [pat, sam])
            yield* requests.apply(
              { agentId, person, askedAt: Instant(1_000), expiresAt: Instant(90_000) },
              1,
            );
          yield* requests.apply({ agentId, person: blocker, blockedAt: Instant(2_000) }, 2);
          yield* requests.settle(agentId);
          expect(yield* listed(pat, 10_000)).toEqual({ agents: [], count: 0 });
          expect(yield* listed(sam, 10_000)).toEqual({ agents: [], count: 0 });
          expect((yield* requests.blockedBy(blocker)).map((row) => row.agentId)).toEqual([agentId]);
        }).pipe(Effect.provide(make())),
    );
  });
}
