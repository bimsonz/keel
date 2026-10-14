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
  it("[token.rate-limit-agent] a token is counted against the agent it was issued to, never its address or the sign-in limit, and dropped past the agent's allowance", async () => {
    const tokens = allowing(2);
    const auth = allowing(1000);
    const via = limited(tokens, auth);
    const keyA = await newKey();
    const keyB = await newKey();
    const a = await seedKeyAgent(keyA);
    const b = await seedKeyAgent(keyB);
    // Two agents from one address: four tokens between them, past either's allowance of two, all issued.
    const statuses: number[] = [];
    for (const [agent, key] of [
      [a, keyA],
      [b, keyB],
      [a, keyA],
      [b, keyB],
    ] as const)
      statuses.push((await tokenFrom(via, "192.0.2.21", agent.id, key)).status);
    expect(statuses).toEqual([200, 200, 200, 200]);
    // An assertion naming B, signed by a key that is not B's, is refused and spends nothing of B's.
    expect((await tokenFrom(via, "192.0.2.21", b.id, keyA)).status).toBe(401);
    // A's third is past its own allowance: dropped, wherever it is asked from.
    const refused = await tokenFrom(via, "192.0.2.22", a.id, keyA);
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(refused.headers.get("content-type")).toBe("application/problem+json");
    expect(await refused.text()).not.toContain("access_token");
    expect(tokens.asked).toEqual([
      `token:agent:${a.id}`,
      `token:agent:${b.id}`,
      `token:agent:${a.id}`,
      `token:agent:${b.id}`,
      "token-failed:192.0.2.21",
      `token:agent:${a.id}`,
    ]);
    expect(auth.asked).toEqual([]);
  });

  it("[token.flood] an address past sixty refused exchanges is refused before the provider for the window, and good exchanges never count against it", async () => {
    const tokens = allowing(60);
    const via = limited(tokens, allowing(1000));
    const key = await newKey();
    const agent = await seedKeyAgent(key);
    const other = await newKey();
    // Good exchanges from one address, past the failure limit in number, are all issued.
    const many = allowing(1000);
    const roomy = limited(many, allowing(1000));
    const good: number[] = [];
    for (let i = 0; i < 70; i++)
      good.push((await tokenFrom(roomy, "192.0.2.41", agent.id, key)).status);
    expect(good.filter((s) => s !== 200)).toEqual([]);
    expect(many.asked.filter((k) => k.startsWith("token-failed:"))).toEqual([]);
    // Sixty-one forged assertions from another address: each refused by the provider, the last blocking it.
    const forged: number[] = [];
    for (let i = 0; i < 61; i++)
      forged.push((await tokenFrom(via, "192.0.2.42", agent.id, other)).status);
    expect(forged.filter((s) => s !== 401)).toEqual([]);
    // Now even the agent's own good assertion from that address is refused, before the provider is asked.
    const before = tokens.asked.length;
    const refused = await tokenFrom(via, "192.0.2.42", agent.id, key);
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(tokens.asked).toHaveLength(before);
    // Another address is not held to it.
    expect((await tokenFrom(via, "192.0.2.43", agent.id, key)).status).toBe(200);
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
