import { describe, expect, it } from "@effect/vitest";
import type { Actor } from "@keeltown/core/domain/identity";
import { OrgId, ProjectId, UserId } from "@keeltown/core/kernel";
import { AgentDirectory, type EnrolInput, Enrolments } from "@keeltown/core/ports";
import { Effect, type Layer, Option, Schema } from "effect";

/**
 * The `Enrolments` suite reads the AgentDirectory beside the port, because an
 * enrolment is good only once its credential verifies there.
 */
export interface EnrolmentsHarness {
  readonly layer: Layer.Layer<Enrolments | AgentDirectory>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const projectId = () => Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
const userId = () => Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);

/** The user minting the credential: the enrolment's actor and its sponsor. */
const sponsoring = (): { readonly actor: Actor; readonly sponsor: UserId } => {
  const sponsor = userId();
  return { actor: { _tag: "User", userId: sponsor }, sponsor };
};

const request = (sponsor: UserId, overrides: Partial<EnrolInput> = {}): EnrolInput => ({
  name: "worker",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  projectId: projectId(),
  org: Schema.decodeUnknownSync(OrgId)(`org_${ulid()}`),
  sponsor,
  idempotencyKey: `key-${crypto.randomUUID()}`,
  ...overrides,
});

export function describeEnrolmentsContract(adapter: string, make: () => EnrolmentsHarness) {
  describe(`Enrolments contract: ${adapter}`, () => {
    it.live("enrols an agent as asked, in the project and org the request names", () => {
      const harness = make();
      return Effect.gen(function* () {
        const { actor, sponsor } = sponsoring();
        const input = request(sponsor);
        const { agent } = yield* (yield* Enrolments).enrol(actor, input);
        expect(agent).toMatchObject({
          name: "worker",
          kind: "interactive",
          scopes: ["agent:read", "agent:work"],
          state: "active",
          projectId: input.projectId,
          org: input.org,
          sponsor,
        });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("answers only once the credential verifies in the AgentDirectory", () => {
      const harness = make();
      return Effect.gen(function* () {
        const { actor, sponsor } = sponsoring();
        const enrolled = yield* (yield* Enrolments).enrol(actor, request(sponsor));
        const directory = yield* AgentDirectory;
        const verified = yield* directory.verifyCredential(
          enrolled.clientId,
          enrolled.clientSecret,
        );
        expect(Option.getOrNull(verified)).toBe(enrolled.agent.id);
        expect(Option.isSome(yield* directory.findAgent(enrolled.agent.id))).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("replays a retry to the same agent with a fresh secret, retiring the old one", () => {
      const harness = make();
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const directory = yield* AgentDirectory;
        const { actor, sponsor } = sponsoring();
        const input = request(sponsor);
        const first = yield* enrolments.enrol(actor, input);
        const again = yield* enrolments.enrol(actor, input);
        expect(again.agent.id).toBe(first.agent.id);
        expect(again.clientId).toBe(first.clientId);
        expect(again.clientSecret).not.toBe(first.clientSecret);
        const fresh = yield* directory.verifyCredential(again.clientId, again.clientSecret);
        expect(Option.getOrNull(fresh)).toBe(first.agent.id);
        const stale = yield* directory.verifyCredential(first.clientId, first.clientSecret);
        expect(Option.isNone(stale)).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("refuses another body under a used key with IdempotencyConflict", () => {
      const harness = make();
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const { actor, sponsor } = sponsoring();
        const input = request(sponsor);
        yield* enrolments.enrol(actor, input);
        const reused = yield* Effect.flip(
          enrolments.enrol(actor, { ...input, name: "someone-else" }),
        );
        expect(reused._tag).toBe("IdempotencyConflict");
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[tenancy.enrol-org] enrols an agent in the org and for the sponsoring user the request names, in the directory too, and refuses another sponsor under its key",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const enrolments = yield* Enrolments;
          const { actor, sponsor } = sponsoring();
          const input = request(sponsor);
          const { agent } = yield* enrolments.enrol(actor, input);
          expect(agent).toMatchObject({ org: input.org, sponsor });
          const found = yield* (yield* AgentDirectory).findAgent(agent.id);
          expect(Option.map(found, (row) => [row.org, row.sponsor])).toEqual(
            Option.some([input.org, sponsor]),
          );
          expect((yield* enrolments.enrol(actor, input)).agent.id).toBe(agent.id);
          const reused = yield* Effect.flip(
            enrolments.enrol(actor, { ...input, sponsor: userId() }),
          );
          expect(reused._tag).toBe("IdempotencyConflict");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("keeps two actors' agents apart even under the same key", () => {
      const harness = make();
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const input = request(userId());
        const a = yield* enrolments.enrol(sponsoring().actor, input);
        const b = yield* enrolments.enrol(sponsoring().actor, input);
        expect(a.agent.id).not.toBe(b.agent.id);
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
