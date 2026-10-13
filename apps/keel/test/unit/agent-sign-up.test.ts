import { describe, expect, it } from "@effect/vitest";
import { signUp } from "@keeltown/core/application/identity";
import { agentIdOf, givenHandle } from "@keeltown/core/domain/identity";
import { UserId } from "@keeltown/core/kernel";
import { EventOutbox, Namespaces } from "@keeltown/core/ports";
import {
  freshAgentKey,
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeEventOutboxMemory,
  makeManualClock,
  makeNamespacesMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Option, Schema } from "effect";

/**
 * One agent's AgentSession state, in memory, beside the directory it projects
 * into and the namespaces its handle is held among.
 */
function object() {
  const directory = makeAgentDirectoryMemory();
  const clock = makeManualClock();
  const rows = makeBetterAuthMemory();
  return {
    directory,
    rows,
    layer: Layer.mergeAll(
      makeEventOutboxMemory().layer,
      clock.layer,
      directory.layer,
      makeNamespacesMemory(rows).layer,
    ),
  };
}

const ADA = Schema.decodeUnknownSync(UserId)("usr_01HZXW5K9QJ8V7R3M2N6P4T0AD");

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
        // The handle is the agent's own namespace, under the agent's id.
        const namespace = { namespace: agentId, handle, kind: "agent", suspended: false };
        const namespaces = yield* Namespaces;
        expect(yield* namespaces.byHandle(handle)).toEqual(Option.some(namespace));
        expect(yield* namespaces.byId(agentId)).toEqual(Option.some(namespace));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[signup.handle-held] a key whose handle another account holds is refused, and nothing is committed or written",
    () => {
      const { directory, rows, layer } = object();
      const key = presented();
      const agentId = agentIdOf(key.jkt);
      const handle = givenHandle(agentId);
      rows.seed({ users: [{ id: ADA, username: handle }] });
      return Effect.gen(function* () {
        const refused = yield* Effect.exit(signUp(agentId, { handle, key }));
        expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain("SignUpRefused");
        expect((yield* EventOutbox).log({ kind: "agent", id: agentId })).toEqual([]);
        expect(directory.agents.has(agentId)).toBe(false);
        // The person keeps the handle.
        expect(
          Option.map(yield* (yield* Namespaces).byHandle(handle), (held) => held.namespace),
        ).toEqual(Option.some(ADA));
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
