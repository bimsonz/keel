import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { agentIdOf } from "@keeltown/core/domain/identity";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  assertionBy,
  newKey,
  proofBy,
  seedKeyAgent,
  type TestKey,
  TOKEN_ENDPOINT,
} from "./agent-keys.ts";
import { BASE, drainOutbox, type Fetch } from "./helpers.ts";

const REGISTER = `${BASE}/v1/oauth/register`;

/** A limiter that allows each key `allowance` requests, and records what it was asked. */
function allowing(allowance: number) {
  const asked: string[] = [];
  return {
    asked,
    limit: async ({ key }: { key: string }) => {
      asked.push(key);
      return { success: asked.filter((k) => k === key).length <= allowance };
    },
  };
}

/** Keel over two limiters of the test's own: a fixed allowance stands in for the binding's window. */
function limited(tokens: ReturnType<typeof allowing>, auth: ReturnType<typeof allowing>) {
  const isolate = makeIsolate({ ...env, TOKEN_LIMIT: tokens, AUTH_LIMIT: auth }, isolateLayer(env));
  const via: Fetch = async (url, init) =>
    isolate.app.fetch(new Request(url, init), env, createExecutionContext());
  return via;
}

const tokenFrom = async (via: Fetch, address: string, agentId: string, account: TestKey) =>
  via(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": address },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await assertionBy(account, agentId),
    }),
  });

const signUpFrom = async (via: Fetch, address: string, key: TestKey) =>
  via(REGISTER, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": address,
      dpop: await proofBy(key, "POST", REGISTER),
    },
    body: JSON.stringify({ jwks: { keys: [key.publicJwk] } }),
  });

describe("the limits on an agent's two ways in", () => {
  it("[token.rate-limit] a token request is counted against its address under the token limit, never the sign-in one, and refused past it before the provider is asked", async () => {
    const tokens = allowing(2);
    const auth = allowing(1000);
    const via = limited(tokens, auth);
    const account = await newKey();
    const agent = await seedKeyAgent(account);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await tokenFrom(via, "192.0.2.21", agent.id, account)).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect(tokens.asked).toEqual(Array.from({ length: 3 }, () => "token:192.0.2.21"));
    expect(auth.asked).toEqual([]);
    const refused = await tokenFrom(via, "192.0.2.21", agent.id, account);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(refused.headers.get("content-type")).toBe("application/problem+json");
    // Another address is not held to this one's count.
    expect((await tokenFrom(via, "192.0.2.22", agent.id, account)).status).toBe(200);
  });

  it("[signup.rate-limit] a sign-up is counted against its address as a person's is, and refused past it with nothing made", async () => {
    const tokens = allowing(1000);
    const auth = allowing(2);
    const via = limited(tokens, auth);
    const last = await newKey();
    const keys = [await newKey(), await newKey(), last];
    const statuses: number[] = [];
    for (const key of keys) statuses.push((await signUpFrom(via, "192.0.2.31", key)).status);
    expect(statuses).toEqual([201, 201, 429]);
    expect(auth.asked).toEqual(Array.from({ length: 3 }, () => "auth:192.0.2.31"));
    expect(tokens.asked).toEqual([]);
    const made = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?")
      .bind(agentIdOf(last.key.jkt))
      .first<{ n: number }>();
    expect(made?.n).toBe(0);
    expect((await signUpFrom(via, "192.0.2.32", last)).status).toBe(201);
    // Each agent's own object flushes what it committed before the file ends.
    for (const key of keys)
      await drainOutbox(
        env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentIdOf(key.key.jkt)}`)),
      );
  });
});
