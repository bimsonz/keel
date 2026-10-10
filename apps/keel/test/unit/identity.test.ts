import { describe, expect, it } from "@effect/vitest";
import { exchangeToken, TOKEN_TTL_SECONDS, type TokenRequest, whoami } from "@keeltown/core/application/identity";
import type { Agent } from "@keeltown/core/domain/identity";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { hashSecret, makeAgentDirectoryMemory, makeClockMemory, makeTokenIssuerMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const agent: Agent = {
  id: agentId,
  name: "unit-agent",
  kind: "interactive",
  scopes: ["agent:read", "agent:work"],
  state: "active",
  revocationEpoch: 2,
  createdAt: Instant(1_760_000_000_000),
};

const secretHash = await hashSecret("secret");

/** The use-cases' ports, in memory, with the directory seeded by `override`. */
function layers(override: Partial<Agent> = {}) {
  const directory = makeAgentDirectoryMemory();
  directory.seed({ ...agent, ...override }, { clientId: "client", agentId, secretHash });
  const clock = makeClockMemory().layer;
  return Layer.mergeAll(directory.layer, makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)), clock);
}

describe("identity/whoami", () => {
  it.effect("answers the agent behind a principal at its current epoch, with no session yet", () =>
    Effect.gen(function* () {
      const identity = yield* whoami({ agentId, scopes: ["agent:read"], revocationEpoch: 2 });
      expect(identity).toEqual({ agent, session: null });
    }).pipe(Effect.provide(layers())),
  );

  it.effect("fails AgentNotKnown for an agent the directory lacks", () =>
    Effect.gen(function* () {
      const other = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
      const error = yield* Effect.flip(whoami({ agentId: other, scopes: [], revocationEpoch: 0 }));
      expect(error._tag).toBe("AgentNotKnown");
    }).pipe(Effect.provide(layers())),
  );

  it.effect.each<{ override: Partial<Agent>; epoch: number; reason: string }>([
    { override: { state: "suspended" }, epoch: 2, reason: "suspended" },
    { override: { state: "revoked" }, epoch: 2, reason: "revoked" },
    { override: {}, epoch: 1, reason: "stale-epoch" },
  ])("fails AgentNotAdmitted as $reason", ({ override, epoch, reason }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(whoami({ agentId, scopes: [], revocationEpoch: epoch }));
      expect(error).toMatchObject({ _tag: "AgentNotAdmitted", reason });
    }).pipe(Effect.provide(layers(override))),
  );
});

describe("identity/exchangeToken", () => {
  it.effect("issues a token for every scope the agent holds, carrying its epoch", () =>
    Effect.gen(function* () {
      const granted = yield* exchangeToken({ clientId: "client", clientSecret: "secret" });
      expect(granted.scopes).toEqual(["agent:read", "agent:work"]);
      expect(granted.expiresAt).toBe(TOKEN_TTL_SECONDS * 1000);
    }).pipe(Effect.provide(layers())),
  );

  it.effect("narrows to the scopes asked for", () =>
    Effect.gen(function* () {
      expect((yield* exchangeToken({ clientId: "client", clientSecret: "secret", scopes: ["agent:read"] })).scopes).toEqual(["agent:read"]);
    }).pipe(Effect.provide(layers())),
  );

  it.effect.each<{ request: TokenRequest; override: Partial<Agent>; tag: string }>([
    { request: { clientId: "client", clientSecret: "wrong" }, override: {}, tag: "CredentialRejected" },
    { request: { clientId: "nobody", clientSecret: "secret" }, override: {}, tag: "CredentialRejected" },
    { request: { clientId: "client", clientSecret: "secret", scopes: ["operator"] }, override: {}, tag: "ScopeNotGranted" },
    { request: { clientId: "client", clientSecret: "secret" }, override: { state: "suspended" }, tag: "AgentNotAdmitted" },
  ])("refuses with $tag", ({ request, override, tag }) =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(exchangeToken(request)))._tag).toBe(tag);
    }).pipe(Effect.provide(layers(override))),
  );
});
