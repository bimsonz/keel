import { describe, expect, it } from "@effect/vitest";
import type { Actor } from "@keeltown/core/domain/identity";
import { AgentId, NamespaceId, ProjectId, UserId } from "@keeltown/core/kernel";
import { AgentDirectory, Enrolments, Sponsorships, Standings } from "@keeltown/core/ports";
import { Effect, type Layer, Option, Schema } from "effect";

/**
 * The `Sponsorships` suite enrols its agents through `Enrolments` (so each
 * starts with the member who enrolled it behind it), pauses one through
 * `Standings`, and reads rows back from the directory. `expire` lets an
 * agent's live request run out without waiting ten minutes.
 */
export interface SponsorshipsHarness {
  readonly layer: Layer.Layer<Sponsorships | Standings | Enrolments | AgentDirectory>;
  readonly expire: (agentId: AgentId) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

type UserActor = Extract<Actor, { readonly _tag: "User" }>;

const user = (): UserActor => ({
  _tag: "User",
  userId: Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`),
});

const enrolled = (by: UserActor) =>
  Effect.map(
    Effect.flatMap(Enrolments, (enrolments) =>
      enrolments.enrol(by, {
        name: "sponsored-agent",
        kind: "interactive",
        scopes: ["agent:read", "agent:work"],
        projectId: Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`),
        namespace: Schema.decodeUnknownSync(NamespaceId)(`org_${ulid()}`),
        sponsor: by.userId,
        idempotencyKey: `enrol-${crypto.randomUUID()}`,
      }),
    ),
    ({ agent }) => agent.id,
  );

const key = () => `link-${crypto.randomUUID()}`;

/** The agent's sponsor and state as the directory holds them: what the request gate and a person's list read. */
const row = (agentId: AgentId) =>
  Effect.map(
    Effect.flatMap(AgentDirectory, (directory) => directory.findAgent(agentId)),
    Option.map((agent) => [agent.sponsor ?? null, agent.state] as const),
  );

/** An agent nobody sponsors: enrolled, then left by the member who enrolled it. */
const alone = Effect.gen(function* () {
  const first = user();
  const agentId = yield* enrolled(first);
  yield* Sponsorships.use((links) => links.end(first, { agentId, idempotencyKey: key() }));
  return agentId;
});

export function describeSponsorshipsContract(adapter: string, make: () => SponsorshipsHarness) {
  describe(`Sponsorships contract: ${adapter}`, () => {
    it.live(
      "[sponsorships.contract] an agent asks, a person approves with its code, and the link ends; each in the directory when it answers",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const links = yield* Sponsorships;
          const first = user();
          const agentId = yield* enrolled(first);
          expect(yield* row(agentId)).toEqual(Option.some([first.userId, "active"]));

          // Somebody already sponsors it: no code is given that could not be used.
          const held = yield* Effect.flip(links.ask(agentId));
          expect(held).toMatchObject({ _tag: "AgentStateRefused", reason: "sponsor-held" });

          const left = yield* links.end(first, { agentId, idempotencyKey: key() });
          expect("sponsor" in left).toBe(false);
          expect(yield* row(agentId)).toEqual(Option.some([null, "active"]));
          const again = yield* Effect.flip(links.end(first, { agentId, idempotencyKey: key() }));
          expect(again).toMatchObject({ _tag: "AgentStateRefused", reason: "not-sponsored" });

          const request = yield* links.ask(agentId);
          expect(request.code.length).toBeGreaterThanOrEqual(26);
          const second = user();
          const guessed = yield* Effect.flip(
            links.approve({
              agentId,
              by: second.userId,
              asked: { _tag: "Code", code: `${request.code}x` },
              idempotencyKey: key(),
            }),
          );
          expect(guessed).toMatchObject({ _tag: "SponsorRequestRefused", agentId });
          expect(yield* row(agentId)).toEqual(Option.some([null, "active"]));

          const sponsored = yield* links.approve({
            agentId,
            by: second.userId,
            asked: { _tag: "Code", code: request.code },
            idempotencyKey: key(),
          });
          expect(sponsored.sponsor).toBe(second.userId);
          expect(yield* row(agentId)).toEqual(Option.some([second.userId, "active"]));
          const theirs = yield* AgentDirectory.use((directory) =>
            directory.sponsoredBy(second.userId),
          );
          expect(theirs.map((agent) => agent.id)).toEqual([agentId]);

          // The code is spent: a third person presenting it learns nothing and changes nothing.
          const third = user();
          const spent = yield* Effect.flip(
            links.approve({
              agentId,
              by: third.userId,
              asked: { _tag: "Code", code: request.code },
              idempotencyKey: key(),
            }),
          );
          expect(spent).toMatchObject({ _tag: "SponsorRequestRefused" });
          expect(yield* row(agentId)).toEqual(Option.some([second.userId, "active"]));
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[sponsorships.contract] an approval needs the agent's live request: none, a replaced one and an expired one are each refused",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const links = yield* Sponsorships;
          const agentId = yield* alone;
          const by = user().userId;
          const approve = (code: string) =>
            links.approve({ agentId, by, asked: { _tag: "Code", code }, idempotencyKey: key() });

          // The agent never asked.
          expect(yield* Effect.flip(approve("no-such-code"))).toMatchObject({
            _tag: "SponsorRequestRefused",
          });

          // A new request replaces the last.
          const first = yield* links.ask(agentId);
          const second = yield* links.ask(agentId);
          expect(second.code).not.toBe(first.code);
          expect(yield* Effect.flip(approve(first.code))).toMatchObject({
            _tag: "SponsorRequestRefused",
          });

          // It runs out.
          yield* harness.expire(agentId);
          expect(yield* Effect.flip(approve(second.code))).toMatchObject({
            _tag: "SponsorRequestRefused",
          });
          expect(yield* row(agentId)).toEqual(Option.some([null, "active"]));

          const third = yield* links.ask(agentId);
          expect((yield* approve(third.code)).sponsor).toBe(by);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[sponsorships.contract] the provider's consent needs no code, one person sponsors an agent at a time, and the same person again changes nothing",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const links = yield* Sponsorships;
          const agentId = yield* alone;
          const first = user().userId;
          const consent = (by: UserId) =>
            links.approve({ agentId, by, asked: { _tag: "Consent" }, idempotencyKey: key() });
          expect((yield* consent(first)).sponsor).toBe(first);
          expect((yield* consent(first)).sponsor).toBe(first);
          const another = yield* Effect.flip(consent(user().userId));
          expect(another).toMatchObject({ _tag: "AgentStateRefused", reason: "sponsor-held" });
          expect(yield* row(agentId)).toEqual(Option.some([first, "active"]));
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[sponsorships.contract] ending the link reinstates a paused agent, in the directory too",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const links = yield* Sponsorships;
          const sponsor = user();
          const agentId = yield* enrolled(sponsor);
          yield* Standings.use((standings) =>
            standings.suspend(sponsor, { agentId, reason: "paused", idempotencyKey: key() }),
          );
          expect(yield* row(agentId)).toEqual(Option.some([sponsor.userId, "suspended"]));
          const ended = yield* links.end(sponsor, { agentId, idempotencyKey: key() });
          expect(ended.state).toBe("active");
          expect("sponsor" in ended).toBe(false);
          expect(yield* row(agentId)).toEqual(Option.some([null, "active"]));
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[sponsorships.contract] answers a replayed key with the agent, a reused key with another body as IdempotencyConflict, and an unknown agent as AgentNotKnown",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const links = yield* Sponsorships;
          const agentId = yield* alone;
          const by = user().userId;
          const approval = {
            agentId,
            by,
            asked: { _tag: "Consent" as const },
            idempotencyKey: key(),
          };
          yield* links.approve(approval);
          expect((yield* links.approve(approval)).sponsor).toBe(by);
          const reused = yield* Effect.flip(links.approve({ ...approval, by: user().userId }));
          expect(reused).toMatchObject({ _tag: "IdempotencyConflict" });

          const ending = { agentId, idempotencyKey: key() };
          const sponsor: UserActor = { _tag: "User", userId: by };
          yield* links.end(sponsor, ending);
          expect("sponsor" in (yield* links.end(sponsor, ending))).toBe(false);
          const other = yield* Effect.flip(links.end({ _tag: "Agent", agentId }, ending));
          expect(other).toMatchObject({ _tag: "IdempotencyConflict" });

          const unknown = Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`);
          expect(yield* Effect.flip(links.ask(unknown))).toMatchObject({
            _tag: "AgentNotKnown",
            agentId: unknown,
          });
          const missing = yield* Effect.flip(
            links.approve({ ...approval, agentId: unknown, idempotencyKey: key() }),
          );
          expect(missing).toMatchObject({ _tag: "AgentNotKnown", agentId: unknown });
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
