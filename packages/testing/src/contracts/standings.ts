import { describe, expect, it } from "@effect/vitest";
import type { AgentToken } from "@keeltown/core/domain/identity";
import { AgentId, ProjectId } from "@keeltown/core/kernel";
import { AgentDirectory, Enrolments, Standings } from "@keeltown/core/ports";
import { Effect, type Layer, Option, Schema } from "effect";

/** The `Standings` suite enrols its agents through `Enrolments`, as an operator would, and reads their rows back from the directory. */
export interface StandingsHarness {
  readonly layer: Layer.Layer<Standings | Enrolments | AgentDirectory>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

const operator = (): AgentToken => ({
  agentId: Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`),
  projectId: Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`),
  scopes: ["operator"],
  revocationEpoch: 0,
});

const enrolled = (by: AgentToken) =>
  Effect.map(
    Effect.flatMap(Enrolments, (enrolments) =>
      enrolments.enrol(by, {
        name: "standing-agent",
        kind: "interactive",
        scopes: ["agent:read", "agent:work"],
        idempotencyKey: `enrol-${crypto.randomUUID()}`,
      }),
    ),
    ({ agent }) => agent.id,
  );

const key = () => `standing-${crypto.randomUUID()}`;

/** The agent's state and epoch as the directory holds them: what the request gate reads. */
const row = (agentId: AgentId) =>
  Effect.map(
    Effect.flatMap(AgentDirectory, (directory) => directory.findAgent(agentId)),
    Option.map((agent) => [agent.state, agent.revocationEpoch] as const),
  );

export function describeStandingsContract(adapter: string, make: () => StandingsHarness) {
  describe(`Standings contract: ${adapter}`, () => {
    it.live(
      "[b11.standing] suspends, reinstates and revokes, each in the directory when it answers",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const standings = yield* Standings;
          const by = operator();
          const agentId = yield* enrolled(by);
          const suspended = yield* standings.suspend(by, {
            agentId,
            reason: "runaway retries",
            idempotencyKey: key(),
          });
          expect(suspended.state).toBe("suspended");
          expect(yield* row(agentId)).toEqual(Option.some(["suspended", 0]));
          const reinstated = yield* standings.reinstate(by, { agentId, idempotencyKey: key() });
          expect(reinstated.state).toBe("active");
          expect(yield* row(agentId)).toEqual(Option.some(["active", 0]));
          const revoked = yield* standings.revoke(by, { agentId, idempotencyKey: key() });
          expect(revoked).toMatchObject({ state: "revoked", revocationEpoch: 1 });
          expect(yield* row(agentId)).toEqual(Option.some(["revoked", 1]));
          const again = yield* Effect.flip(
            standings.revoke(by, { agentId, idempotencyKey: key() }),
          );
          expect(again).toMatchObject({ _tag: "AgentStateRefused", agentId, command: "Revoke" });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[b11.standing] answers a replayed key with the agent, a reused key with another body as IdempotencyConflict, and an unknown agent as AgentNotKnown",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const standings = yield* Standings;
          const by = operator();
          const agentId = yield* enrolled(by);
          const input = { agentId, reason: "runaway retries", idempotencyKey: "suspend-0001" };
          yield* standings.suspend(by, input);
          expect((yield* standings.suspend(by, input)).state).toBe("suspended");
          const reused = yield* Effect.flip(
            standings.suspend(by, { ...input, reason: "another reason" }),
          );
          expect(reused).toMatchObject({ _tag: "IdempotencyConflict" });
          const unknown = Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`);
          const missing = yield* Effect.flip(
            standings.suspend(by, { agentId: unknown, reason: "x", idempotencyKey: "s-0002" }),
          );
          expect(missing).toMatchObject({ _tag: "AgentNotKnown", agentId: unknown });
          expect(yield* row(agentId)).toEqual(Option.some(["suspended", 0]));
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
