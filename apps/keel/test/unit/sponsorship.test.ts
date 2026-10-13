import { describe, expect, it } from "@effect/vitest";
import {
  approveSponsor,
  askSponsor,
  changeStanding,
  endSponsorship,
  enrol,
} from "@keeltown/core/application/identity";
import { makeId, userActor } from "@keeltown/core/kernel";
import {
  makeAgentDirectoryMemory,
  makeEventOutboxMemory,
  makeManualClock,
  sampleOrgId,
  sampleProjectId,
  ulidOf,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";

const agentId = makeId("agt", ulidOf(41));
const first = makeId("usr", ulidOf(42));
const second = makeId("usr", ulidOf(43));

/** An agent enrolled by a member in its AgentSession DO's state, its directory row written, and nothing projecting. */
function enrolledAgent() {
  const directory = makeAgentDirectoryMemory();
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeManualClock().layer,
    directory.layer,
  );
  const enrolled = enrol(agentId, {
    projectId: sampleProjectId,
    name: "sponsored-agent",
    kind: "interactive",
    scopes: ["agent:read", "agent:work"],
    org: sampleOrgId,
    sponsor: first,
    clientId: `client-${agentId.toLowerCase()}`,
    secretHash: "sha256:aa",
    idempotencyKey: "enrol-1",
    fingerprint: "enrol-body",
  });
  return { directory, layer, enrolled };
}

/** The agent's sponsor and state as the directory holds them: what the request gate reads. */
const row = (directory: ReturnType<typeof makeAgentDirectoryMemory>) => {
  const agent = directory.agents.get(agentId);
  return agent === undefined ? undefined : [agent.sponsor ?? null, agent.state];
};

describe("[link.sponsor-inline] a sponsor link is in the directory when its move answers", () => {
  it.effect(
    "[link.sponsor-inline] an end and an approval each write the row before answering, with no Projector, and ending while paused writes the standing too",
    () => {
      const { directory, layer, enrolled } = enrolledAgent();
      return Effect.gen(function* () {
        yield* enrolled;
        expect(row(directory)).toEqual([first, "active"]);
        yield* changeStanding(agentId, "suspend", {
          by: `operator:${first}`,
          reason: "paused by its sponsor",
          idempotencyKey: "suspend-1",
          fingerprint: "suspend-body",
        });
        expect(row(directory)).toEqual([first, "suspended"]);

        const ending = { by: userActor(first), idempotencyKey: "end-1", fingerprint: "end-body" };
        const ended = yield* endSponsorship(agentId, ending);
        expect(ended.state).toBe("active");
        expect("sponsor" in ended).toBe(false);
        expect(row(directory)).toEqual([null, "active"]);

        yield* askSponsor(agentId, "sha256:the-code");
        const sponsored = yield* approveSponsor(agentId, {
          by: second,
          codeHash: "sha256:the-code",
          idempotencyKey: "approve-1",
          fingerprint: "approve-body",
        });
        expect(sponsored.sponsor).toBe(second);
        expect(row(directory)).toEqual([second, "active"]);

        // A replay of the end answers the agent as it stands, and its older seq moves nothing.
        const replayed = yield* endSponsorship(agentId, ending);
        expect(replayed.sponsor).toBe(second);
        expect(row(directory)).toEqual([second, "active"]);
      }).pipe(Effect.provide(layer));
    },
  );
});
