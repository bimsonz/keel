import { describe, expect, it } from "@effect/vitest";
import { signUp } from "@keeltown/core/application/identity";
import { agentIdOf, givenHandle } from "@keeltown/core/domain/identity";
import { EventOutbox } from "@keeltown/core/ports";
import {
  freshAgentKey,
  makeAgentDirectoryMemory,
  makeEventOutboxMemory,
  makeManualClock,
} from "@keeltown/testing";
import { Effect, Exit, Layer } from "effect";

/** One agent's AgentSession state, in memory, beside the directory it projects into. */
function object() {
  const directory = makeAgentDirectoryMemory();
  const clock = makeManualClock();
  return {
    directory,
    layer: Layer.mergeAll(makeEventOutboxMemory().layer, clock.layer, directory.layer),
  };
}

const presented = () => {
  const { jkt, jwk } = freshAgentKey();
  return { jkt, jwk };
};

describe("signUp, in the agent's own object", () => {
  it.effect(
    "[signup.inline] commits AgentSignedUp and writes the directory row with its key before answering",
    () => {
      const { directory, layer } = object();
      const key = presented();
      const agentId = agentIdOf(key.jkt);
      const handle = givenHandle(agentId);
      return Effect.gen(function* () {
        const agent = yield* signUp(agentId, { handle, key });
        const log = (yield* EventOutbox).log({ kind: "agent", id: agentId });
        expect(log.map((event) => [event.type, event.actor])).toEqual([
          ["AgentSignedUp", `agent:${agentId}`],
        ]);
        expect(agent).toMatchObject({ id: agentId, handle, state: "active", revocationEpoch: 0 });
        expect(agent.keys?.map((held) => held.jkt)).toEqual([key.jkt]);
        expect(directory.agents.get(agentId)).toEqual(agent);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[signup.inline] the same key again answers the same agent, commits nothing more, and writes the row again",
    () => {
      const { directory, layer } = object();
      const key = presented();
      const agentId = agentIdOf(key.jkt);
      const handle = givenHandle(agentId);
      return Effect.gen(function* () {
        const first = yield* signUp(agentId, { handle, key });
        directory.agents.delete(agentId);
        const again = yield* signUp(agentId, { handle, key });
        expect(again).toEqual(first);
        expect((yield* EventOutbox).log({ kind: "agent", id: agentId })).toHaveLength(1);
        expect(directory.agents.get(agentId)).toEqual(first);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("[signup.inline] another key under the same id is refused and changes nothing", () => {
    const { directory, layer } = object();
    const key = presented();
    const agentId = agentIdOf(key.jkt);
    const handle = givenHandle(agentId);
    return Effect.gen(function* () {
      const first = yield* signUp(agentId, { handle, key });
      const intruder = yield* Effect.exit(signUp(agentId, { handle, key: presented() }));
      expect(Exit.isFailure(intruder) && JSON.stringify(intruder.cause)).toContain("SignUpRefused");
      expect((yield* EventOutbox).log({ kind: "agent", id: agentId })).toHaveLength(1);
      expect(directory.agents.get(agentId)).toEqual(first);
    }).pipe(Effect.provide(layer));
  });
});
