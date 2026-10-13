import { describe, expect, it } from "@effect/vitest";
import { changeStanding, enrol, standingOf } from "@keeltown/core/application/identity";
import { makeId, userActor } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeEventOutboxMemory,
  makeManualClock,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";

const agentId = makeId("agt", ulidOf(31));

/** An agent enrolled in its AgentSession DO's state, its directory row written, and nothing projecting. */
function enrolledAgent() {
  const directory = makeAgentDirectoryMemory();
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeManualClock().layer,
    directory.layer,
  );
  const enrolled = enrol(agentId, {
    projectId: sampleProjectId,
    name: "standing-agent",
    kind: "interactive",
    scopes: ["agent:read", "agent:work"],
    clientId: `client-${agentId.toLowerCase()}`,
    secretHash: "sha256:aa",
    idempotencyKey: "enrol-1",
    fingerprint: "enrol-body",
  });
  return { directory, layer, enrolled };
}

const by = userActor(makeId("usr", "01JZ8PT2C4E6G8J0M2N4Q6S8V0"));
const row = (directory: ReturnType<typeof makeAgentDirectoryMemory>) => {
  const agent = directory.agents.get(agentId);
  return agent === undefined ? undefined : [agent.state, agent.revocationEpoch];
};

describe("[b11.standing-inline] a standing is in the directory when its move answers", () => {
  it.effect(
    "[b11.standing-inline] suspend, reinstate and revoke each write the row before answering, with no Projector",
    () => {
      const { directory, layer, enrolled } = enrolledAgent();
      return Effect.gen(function* () {
        yield* enrolled;
        const suspended = yield* changeStanding(agentId, "suspend", {
          by,
          reason: "runaway retries",
          idempotencyKey: "suspend-1",
          fingerprint: "suspend-body",
        });
        expect(suspended.state).toBe("suspended");
        expect(row(directory)).toEqual(["suspended", 0]);
        yield* changeStanding(agentId, "reinstate", {
          by,
          idempotencyKey: "reinstate-1",
          fingerprint: "reinstate-body",
        });
        expect(row(directory)).toEqual(["active", 0]);
        const revoked = yield* changeStanding(agentId, "revoke", {
          by,
          idempotencyKey: "revoke-1",
          fingerprint: "revoke-body",
        });
        expect(revoked).toMatchObject({ state: "revoked", revocationEpoch: 1 });
        expect(row(directory)).toEqual(["revoked", 1]);

        // A replay of the suspension answers the agent as it stands, and its older seq moves nothing.
        const replayed = yield* changeStanding(agentId, "suspend", {
          by,
          reason: "runaway retries",
          idempotencyKey: "suspend-1",
          fingerprint: "suspend-body",
        });
        expect(replayed.state).toBe("revoked");
        expect(row(directory)).toEqual(["revoked", 1]);

        const log = yield* Effect.map(EventOutbox, (outbox) =>
          outbox.log({ kind: "agent", id: agentId }),
        );
        expect(log.map((event) => event.type)).toEqual([
          "AgentEnrolled",
          "AgentSuspended",
          "AgentReinstated",
          "AgentRevoked",
        ]);
        expect(log.every((event) => event.project === sampleProjectId)).toBe(true);
        expect(log.slice(1).map((event) => event.actor)).toEqual([by, by, by]);
        expect(log.map(standingOf)).toEqual([
          undefined,
          { agentId, standing: { state: "suspended" }, seq: 2 },
          { agentId, standing: { state: "active" }, seq: 3 },
          { agentId, standing: { state: "revoked", revocationEpoch: 1 }, seq: 4 },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b11.standing-inline] refuses a move the agent's state does not allow, an unknown agent, and a reused key with another body",
    () => {
      const { layer, enrolled } = enrolledAgent();
      return Effect.gen(function* () {
        yield* enrolled;
        const reinstate = yield* Effect.flip(
          changeStanding(agentId, "reinstate", {
            by,
            idempotencyKey: "reinstate-1",
            fingerprint: "reinstate-body",
          }),
        );
        expect(reinstate).toMatchObject({ _tag: "AgentStateRefused", state: "active" });
        yield* changeStanding(agentId, "suspend", {
          by,
          reason: "runaway retries",
          idempotencyKey: "suspend-1",
          fingerprint: "suspend-body",
        });
        const reused = yield* Effect.flip(
          changeStanding(agentId, "suspend", {
            by,
            reason: "another reason",
            idempotencyKey: "suspend-1",
            fingerprint: "another-body",
          }),
        );
        expect(reused).toMatchObject({ _tag: "IdempotencyConflict" });
        const unknown = makeId("agt", ulidOf(32));
        const missing = yield* Effect.flip(
          changeStanding(unknown, "revoke", {
            by,
            idempotencyKey: "revoke-1",
            fingerprint: "revoke-body",
          }),
        );
        expect(missing).toMatchObject({ _tag: "AgentNotKnown", agentId: unknown });
      }).pipe(Effect.provide(layer));
    },
  );
});
