import { describe, expect, it } from "@effect/vitest";
import { agentIdOf, givenHandle, type PresentedKey } from "@keeltown/core/domain/identity";
import { AgentDirectory, AgentSignUps, Namespaces, type SignUpInput } from "@keeltown/core/ports";
import { Effect, Exit, type Layer, Option } from "effect";
import { freshAgentKey } from "./index.ts";

/**
 * The `AgentSignUps` suite reads the AgentDirectory beside the port, because a
 * sign-up is good only once the agent's key is there for the token endpoint,
 * and the Namespaces the sign-up holds the agent's handle among.
 */
export interface AgentSignUpsHarness {
  readonly layer: Layer.Layer<AgentSignUps | AgentDirectory | Namespaces>;
}

const presented = (): PresentedKey => {
  const { jkt, jwk } = freshAgentKey();
  return { jkt, jwk };
};

/** A sign-up as the doorway sends it for `key`: the id and the handle made from it. */
const signingUp = (key: PresentedKey, overrides: Partial<SignUpInput> = {}): SignUpInput => {
  const agentId = agentIdOf(key.jkt);
  return { agentId, handle: givenHandle(agentId), key, ...overrides };
};

export function describeAgentSignUpsContract(adapter: string, make: () => AgentSignUpsHarness) {
  describe(`AgentSignUps contract: ${adapter}`, () => {
    it.effect(
      "[signup.one-account-per-key] signs a key up as the agent it names, in the directory at once, and the same key again is that agent",
      () =>
        Effect.gen(function* () {
          const signUps = yield* AgentSignUps;
          const directory = yield* AgentDirectory;
          const key = presented();
          const request = signingUp(key);
          const agent = yield* signUps.signUp(request);
          expect(agent).toMatchObject({
            id: request.agentId,
            handle: request.handle,
            name: request.handle,
            scopes: ["agent:work", "agent:read"],
            state: "active",
            revocationEpoch: 0,
          });
          expect(agent.keys?.map(({ jkt, jwk }) => ({ jkt, jwk }))).toEqual([key]);
          expect("projectId" in agent || "kind" in agent || "sponsor" in agent).toBe(false);
          expect(yield* directory.findAgent(request.agentId)).toEqual(Option.some(agent));
          expect(yield* signUps.signUp(request)).toEqual(agent);
          expect(yield* directory.findAgent(request.agentId)).toEqual(Option.some(agent));
        }).pipe(Effect.provide(make().layer)),
    );
    it.effect(
      "[signup.namespace] a signed-up agent's handle is its own namespace, of kind agent under its id",
      () =>
        Effect.gen(function* () {
          const namespaces = yield* Namespaces;
          const request = signingUp(presented());
          yield* (yield* AgentSignUps).signUp(request);
          const record = {
            namespace: request.agentId,
            handle: request.handle,
            kind: "agent",
            suspended: false,
          };
          expect(yield* namespaces.byHandle(request.handle)).toEqual(Option.some(record));
          expect(yield* namespaces.byId(request.agentId)).toEqual(Option.some(record));
        }).pipe(Effect.provide(make().layer)),
    );
    it.effect(
      "[signup.handle-held] a key whose handle another account holds signs nothing up, and the handle stays that account's",
      () =>
        Effect.gen(function* () {
          const signUps = yield* AgentSignUps;
          const directory = yield* AgentDirectory;
          const namespaces = yield* Namespaces;
          const request = signingUp(presented());
          const holder = agentIdOf(presented().jkt);
          expect(yield* namespaces.holdForAgent(holder, request.handle)).toBe(true);
          const refused = yield* Effect.exit(signUps.signUp(request));
          expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain(
            "SignUpRefused",
          );
          expect(Option.isNone(yield* directory.findAgent(request.agentId))).toBe(true);
          expect(
            Option.map(yield* namespaces.byHandle(request.handle), (held) => held.namespace),
          ).toEqual(Option.some(holder));
        }).pipe(Effect.provide(make().layer)),
    );
    it.effect(
      "[signup.one-account-per-key] another key never joins an account by signing up under its id",
      () =>
        Effect.gen(function* () {
          const signUps = yield* AgentSignUps;
          const directory = yield* AgentDirectory;
          const key = presented();
          const request = signingUp(key);
          const agent = yield* signUps.signUp(request);
          const intruder = yield* Effect.exit(signUps.signUp({ ...request, key: presented() }));
          expect(Exit.isFailure(intruder) && JSON.stringify(intruder.cause)).toContain(
            "SignUpRefused",
          );
          expect(yield* directory.findAgent(request.agentId)).toEqual(Option.some(agent));
        }).pipe(Effect.provide(make().layer)),
    );
    it.effect("[signup.name] keeps the name an agent gives itself beside its handle", () =>
      Effect.gen(function* () {
        const signUps = yield* AgentSignUps;
        const request = signingUp(presented(), { name: "builder" });
        expect(yield* signUps.signUp(request)).toMatchObject({
          handle: request.handle,
          name: "builder",
        });
      }).pipe(Effect.provide(make().layer)),
    );
  });
}
