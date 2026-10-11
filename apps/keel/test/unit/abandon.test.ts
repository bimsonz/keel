import { describe, expect, it } from "@effect/vitest";
import { type AbandonInput, abandonChange } from "@keeltown/core/application/coordination";
import type { AgentToken } from "@keeltown/core/domain/identity";
import { AgentId, makeId, ProjectId } from "@keeltown/core/kernel";
import { Changes } from "@keeltown/core/ports";
import { makeChangesMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const projectId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const agent: AgentToken = {
  agentId: Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0"),
  projectId,
  scopes: ["agent:read", "agent:work"],
  revocationEpoch: 0,
};
const operator: AgentToken = {
  ...agent,
  agentId: Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V1"),
  scopes: ["operator"],
};

/** The in-memory Changes, with every abandon the gateway hands it recorded. */
function recorded() {
  const memory = makeChangesMemory();
  const sent: AbandonInput[] = [];
  const layer = Layer.effect(
    Changes,
    Effect.map(Changes, (changes) =>
      Changes.of({
        ...changes,
        abandon: (principal, input) => {
          sent.push(input);
          return changes.abandon(principal, input);
        },
      }),
    ),
  ).pipe(Layer.provide(memory.layer));
  const declared = Changes.use((changes) =>
    changes.declare(agent, {
      goal: "Cache permission lookups per request",
      footprint: [],
      premises: [],
      idempotencyKey: `declare-${crypto.randomUUID()}`,
    }),
  );
  return { sent, layer, declared };
}

describe("abandonChange", () => {
  it.effect(
    "[a11.abandon-authority] a lease header is the Lease authority, whatever the scopes",
    () => {
      const { sent, layer, declared } = recorded();
      return Effect.gen(function* () {
        const { change } = yield* declared;
        const withdrawn = yield* abandonChange(
          { ...operator, scopes: ["operator", "agent:work"] },
          { changeId: change.id, lease: change.lease.id, idempotencyKey: "abandon-1" },
        );
        expect(withdrawn.state).toBe("withdrawn");
        expect(sent.map((input) => input.authority)).toEqual([
          { _tag: "Lease", leaseId: change.lease.id },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[a11.abandon-authority] no lease from an operator is the Operator authority, by the operator's agent",
    () => {
      const { sent, layer, declared } = recorded();
      return Effect.gen(function* () {
        const { change } = yield* declared;
        yield* abandonChange(operator, {
          changeId: change.id,
          reason: "Parked for a day",
          idempotencyKey: "abandon-2",
        });
        expect(sent).toEqual([
          {
            changeId: change.id,
            authority: { _tag: "Operator", by: operator.agentId },
            reason: "Parked for a day",
            idempotencyKey: "abandon-2",
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[a11.abandon-authority] no lease from anyone else is LeaseRequired, and the change is never asked",
    () => {
      const { sent, layer, declared } = recorded();
      return Effect.gen(function* () {
        const { change } = yield* declared;
        const error = yield* Effect.flip(
          abandonChange(agent, { changeId: change.id, idempotencyKey: "abandon-3" }),
        );
        expect(error).toMatchObject({ _tag: "LeaseRequired", changeId: change.id });
        expect(sent).toEqual([]);
        expect((yield* Changes.use((changes) => changes.get(change.id))).change.state).toBe(
          "working",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("passes the Change DO's refusals through: a stale lease is LeaseStale", () => {
    const { layer, declared } = recorded();
    return Effect.gen(function* () {
      const { change } = yield* declared;
      const stale = makeId("lse", "01JZ8PT2C4E6G8J0M2N4Q6S8V9");
      const error = yield* Effect.flip(
        abandonChange(agent, { changeId: change.id, lease: stale, idempotencyKey: "abandon-4" }),
      );
      expect(error).toMatchObject({ _tag: "LeaseStale", leaseId: stale });
    }).pipe(Effect.provide(layer));
  });
});
