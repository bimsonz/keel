import { TOKEN_TTL_SECONDS } from "@keeltown/core/application/identity";
import type { Agent } from "@keeltown/core/domain/identity";
import { AgentId, Instant } from "@keeltown/core/kernel";
import { Clock, TokenIssuer } from "@keeltown/core/ports";
import {
  hashSecret,
  makeAgentDirectoryMemory,
  makeChangesMemory,
  makeClockMemory,
  makeCodeHostMemory,
  makeEnrolmentsMemory,
  makeIdsMemory,
  makeEventFeedMemory,
  makeProbeLedgerMemory,
  makeProbeStoreMemory,
  makeProjectViewsMemory,
  makeInboxMemory,
  makeMembershipsMemory,
  makeOrgsMemory,
  makeProjectOrgsMemory,
  makeProjectsMemory,
  makeSessionsMemory,
  makeSponsorshipsMemory,
  makeStandingsMemory,
  makeUsersMemory,
  sampleOrgId,
  sampleProjectId,
  sampleSponsorId,
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

/** The handlers over in-memory ports and the real token issuer, with `seeded` holding credential `client`/`secret`. */
async function serve(seeded: Agent, clock: Layer.Layer<Clock>) {
  const directory = makeAgentDirectoryMemory();
  directory.seed(seeded, {
    clientId: "client",
    agentId: seeded.id,
    secretHash: await hashSecret("secret"),
  });
  const inbox = makeInboxMemory();
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      directory.layer,
      TokenIssuerJose({ privateJwk, issuer: "keel.unit" }).pipe(Layer.provide(clock)),
      clock,
      makeIdsMemory().layer,
      makeChangesMemory().layer,
      inbox.layer,
      inbox.notifier,
      makeEventFeedMemory().layer,
      makeProjectViewsMemory().layer,
      makeProbeStoreMemory().layer,
      makeProbeLedgerMemory().world,
      makeProjectsMemory().layer,
      makeEnrolmentsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeCodeHostMemory().layer,
      makeSessionsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeStandingsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeSponsorshipsMemory().layer.pipe(Layer.provide(directory.layer)),
      makeUsersMemory().layer,
      makeMembershipsMemory().layer,
      makeOrgsMemory().layer,
      makeProjectOrgsMemory().layer,
    ),
  );
  const handlers = makeHandlers(makeRunner(runtime), { emailCode: false, github: false });
  const answer = await handlers.Auth_exchangeToken(
    { requestId: "req-1", principal: { _tag: "Anonymous" }, signal: new AbortController().signal },
    { client_id: "client", client_secret: "secret" },
  );
  return { runtime, answer };
}

describe("the token endpoint", () => {
  it("[c6.expires-in] answers expires_in as the token's lifetime, its exp is iat + TTL, with the clock at x.999 s and moving", async () => {
    // The first reading stamps the token; every later one is past the next second.
    const { runtime, answer } = await serve(
      agent,
      steppingClock([1_760_000_000_999, 1_760_000_001_250]),
    );
    await runtime.dispose();
    expect(answer.status).toBe(200);
    const body = Reflect.get(Object(answer), "body");
    expect(body).toMatchObject({ expires_in: TOKEN_TTL_SECONDS, token_type: "Bearer" });
    const claims = decodeJwt(String(Reflect.get(Object(body), "access_token")));
    expect(claims.iat).toBe(1_760_000_000);
    expect(claims.exp).toBe(1_760_000_000 + TOKEN_TTL_SECONDS);
  });

  it("[tenancy.token-exchange] a token for an agent with an org and a sponsoring user verifies to both, its obo the user's id", async () => {
    const tenant: Agent = {
      ...agent,
      org: sampleOrgId,
      sponsor: sampleSponsorId,
    };
    const { runtime, answer } = await serve(tenant, makeClockMemory().layer);
    const token = String(Reflect.get(Object(Reflect.get(Object(answer), "body")), "access_token"));
    const verified = await runtime.runPromise(TokenIssuer.use((issuer) => issuer.verify(token)));
    await runtime.dispose();
    expect(answer.status).toBe(200);
    expect(verified).toEqual({
      agentId,
      projectId: sampleProjectId,
      scopes: ["agent:read"],
      revocationEpoch: 0,
      org: sampleOrgId,
      sponsor: sampleSponsorId,
    });
    expect(decodeJwt(token)).toMatchObject({ org: sampleOrgId, obo: sampleSponsorId });
  });
});
