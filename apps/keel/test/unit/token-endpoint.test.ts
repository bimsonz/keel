import { TOKEN_TTL_SECONDS } from "@keeltown/core/application/identity";
import type { Agent } from "@keeltown/core/domain/identity";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { Clock } from "@keeltown/core/ports";
import {
  hashSecret,
  makeAgentDirectoryMemory,
  makeChangesMemory,
  makeEnrolmentsMemory,
  makeIdsMemory,
  makeInboxMemory,
  makeProjectsMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { decodeJwt } from "jose";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TokenIssuerJose } from "../../src/adapters/driven/jose/token-issuer.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
if (!("privateKey" in pair)) throw new Error("Ed25519 did not generate a key pair");
const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const agent: Agent = {
  id: agentId,
  projectId: sampleProjectId,
  name: "token-agent",
  kind: "interactive",
  scopes: ["agent:read"],
  state: "active",
  revocationEpoch: 0,
  createdAt: Instant(1_760_000_000_000),
};

/** A clock that answers each reading in turn, then holds the last: time moves between reads. */
function steppingClock(readings: readonly number[]) {
  let next = 0;
  return Layer.succeed(
    Clock,
    Clock.of({
      now: Effect.sync(() => Instant(readings[Math.min(next++, readings.length - 1)] ?? 0)),
    }),
  );
}

describe("the token endpoint", () => {
  it("[c6.expires-in] answers expires_in as the token's lifetime, its exp is iat + TTL, with the clock at x.999 s and moving", async () => {
    const directory = makeAgentDirectoryMemory();
    directory.seed(agent, {
      clientId: "client",
      agentId,
      secretHash: await hashSecret("secret"),
    });
    // The first reading stamps the token; every later one is past the next second.
    const clock = steppingClock([1_760_000_000_999, 1_760_000_001_250]);
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        directory.layer,
        TokenIssuerJose({ privateJwk, issuer: "keel.unit" }).pipe(Layer.provide(clock)),
        clock,
        makeIdsMemory().layer,
        makeChangesMemory().layer,
        makeInboxMemory().layer,
        makeProjectsMemory().layer,
        makeEnrolmentsMemory().layer.pipe(Layer.provide(directory.layer)),
      ),
    );
    const handlers = makeHandlers(makeRunner(runtime));
    const answer = await handlers.Auth_exchangeToken(
      { requestId: "req-1", principal: null, signal: new AbortController().signal },
      { client_id: "client", client_secret: "secret" },
    );
    await runtime.dispose();
    expect(answer.status).toBe(200);
    const body = Reflect.get(Object(answer), "body");
    expect(body).toMatchObject({ expires_in: TOKEN_TTL_SECONDS, token_type: "Bearer" });
    const claims = decodeJwt(String(Reflect.get(Object(body), "access_token")));
    expect(claims.iat).toBe(1_760_000_000);
    expect(claims.exp).toBe(1_760_000_000 + TOKEN_TTL_SECONDS);
  });
});
