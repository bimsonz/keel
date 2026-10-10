import { describe, expect, it } from "@effect/vitest";
import type { Principal } from "@keeltown/core/domain/identity";
import { AgentId, ProjectId } from "@keeltown/core/kernel";
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

const operator = (): Principal => ({
  agentId: Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`),
  projectId: projectId(),
  scopes: ["operator"],
  revocationEpoch: 0,
});

const request = (overrides: Partial<EnrolInput> = {}): EnrolInput => ({
  name: "worker",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  idempotencyKey: `key-${crypto.randomUUID()}`,
  ...overrides,
});

export function describeEnrolmentsContract(adapter: string, make: () => EnrolmentsHarness) {
  describe(`Enrolments contract: ${adapter}`, () => {
    it.live("enrols an agent as asked, in the operator's project by default", () => {
      const harness = make();
      return Effect.gen(function* () {
        const by = operator();
        const { agent } = yield* (yield* Enrolments).enrol(by, request());
        expect(agent).toMatchObject({
          name: "worker",
          kind: "interactive",
          scopes: ["agent:read", "agent:work"],
          state: "active",
          projectId: by.projectId,
        });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("puts the agent in the project the request names", () => {
      const harness = make();
      return Effect.gen(function* () {
        const target = projectId();
        const { agent } = yield* (yield* Enrolments).enrol(
          operator(),
          request({ projectId: target }),
        );
        expect(agent.projectId).toBe(target);
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("answers only once the credential verifies in the AgentDirectory", () => {
      const harness = make();
      return Effect.gen(function* () {
        const enrolled = yield* (yield* Enrolments).enrol(operator(), request());
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
        const by = operator();
        const input = request();
        const first = yield* enrolments.enrol(by, input);
        const again = yield* enrolments.enrol(by, input);
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
        const by = operator();
        const idempotencyKey = `key-${crypto.randomUUID()}`;
        yield* enrolments.enrol(by, request({ idempotencyKey }));
        const reused = yield* Effect.flip(
          enrolments.enrol(by, request({ idempotencyKey, name: "someone-else" })),
        );
        expect(reused._tag).toBe("IdempotencyConflict");
      }).pipe(Effect.provide(harness.layer));
    });

    it.live("keeps two operators' agents apart even under the same key", () => {
      const harness = make();
      return Effect.gen(function* () {
        const enrolments = yield* Enrolments;
        const input = request();
        const a = yield* enrolments.enrol(operator(), input);
        const b = yield* enrolments.enrol(operator(), input);
        expect(a.agent.id).not.toBe(b.agent.id);
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
