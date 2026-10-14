import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createKeelClient, KeelProblem } from "@keeltown/sdk";
import { describe, expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  Auth_exchangeTokenResponse429Headers,
  tooManyRequestsSchema,
} from "../../src/generated/http/schemas.gen.ts";
import { BASE, type Fetch, seedAgent, type SeededAgent, worker } from "./helpers.ts";

/** One exchange as an OAuth client posts it, from `address` as the edge names it (null: no address at all). */
const exchangeFrom = (
  via: Fetch,
  address: string | null,
  credentials: Pick<SeededAgent, "clientId" | "clientSecret">,
) =>
  via(`${BASE}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(address === null ? {} : { "cf-connecting-ip": address }),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

describe("the token endpoint's rate limit", () => {
  it("[oauth.rate-limit-sdk] the SDK reads Keel's own 429 as rate limiting, a minute to wait", async () => {
    const isolate = makeIsolate(
      { ...env, TOKEN_LIMIT: { limit: async () => ({ success: false }) } },
      isolateLayer(env),
    );
    const seeded = await seedAgent();
    const client = createKeelClient({
      baseUrl: BASE,
      clientId: seeded.clientId,
      clientSecret: seeded.clientSecret,
      fetch: async (url, init) =>
        isolate.app.fetch(new Request(url, init), env, createExecutionContext()),
    });
    const refused = await client.token().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(KeelProblem);
    expect(refused).toMatchObject({ status: 429, code: "rate.limited", retryAfterMs: 60_000 });
  });

  it("[oauth.rate-limit-wait] a limited exchange says how long to wait in its body, beside the header", async () => {
    const isolate = makeIsolate(
      { ...env, TOKEN_LIMIT: { limit: async () => ({ success: false }) } },
      isolateLayer(env),
    );
    const limited: Fetch = async (url, init) =>
      isolate.app.fetch(new Request(url, init), env, createExecutionContext());
    const stranger = { clientId: "nobody", clientSecret: "not-a-secret" };
    // The refusal that passes the address's failure limit is answered as it came, and blocks the address.
    expect((await exchangeFrom(limited, "192.0.2.19", stranger)).status).toBe(401);
    const refused = await exchangeFrom(limited, "192.0.2.19", stranger);
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(await refused.json()).toMatchObject({ code: "rate.limited", retryAfterMs: 60_000 });
  });

  it("[oauth.rate-limit] counts an exchange against the agent it issued a token to and a refused one against its address, each refused past sixty", async () => {
    // A fixed allowance stands in for the binding's window, which a slow run could straddle.
    const asked: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        asked.push(key);
        return { success: asked.filter((k) => k === key).length <= 60 };
      },
    };
    const isolate = makeIsolate({ ...env, TOKEN_LIMIT: limiter }, isolateLayer(env));
    const limited: Fetch = async (url, init) =>
      isolate.app.fetch(new Request(url, init), env, createExecutionContext());
    const seeded = await seedAgent();
    const other = await seedAgent();
    const stranger = { clientId: "nobody", clientSecret: "not-a-secret" };

    // Sixty tokens for one agent, and sixty for another, from one address: all issued.
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      statuses.push((await exchangeFrom(limited, "192.0.2.7", seeded)).status);
      statuses.push((await exchangeFrom(limited, "192.0.2.7", other)).status);
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);

    // The agent's sixty-first is refused, from any address: the limiter answers after the exchange.
    const refused: Response[] = [];
    for (const address of ["192.0.2.7", "192.0.2.8", null])
      refused.push(await exchangeFrom(limited, address, seeded));
    expect(refused.map((response) => response.status)).toEqual([429, 429, 429]);
    for (const response of refused) {
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("retry-after")).toBe("60");
      // The 429 the spec declares for Auth_exchangeToken: its headers and its body.
      expect(() =>
        Auth_exchangeTokenResponse429Headers.parse({
          "retry-after": Number(response.headers.get("retry-after")),
        }),
      ).not.toThrow();
      const body: unknown = await response.json();
      expect(() => tooManyRequestsSchema.parse(body)).not.toThrow();
      expect(body).toMatchObject({
        status: 429,
        code: "rate.limited",
        detail: expect.stringMatching(/for this agent; wait a minute/),
      });
    }

    // Bad credentials count against the address they came from, not the client they named:
    // past sixty, that address is refused even a good agent's first token, and another isn't.
    const fresh = await seedAgent();
    for (let i = 0; i < 61; i++)
      expect((await exchangeFrom(limited, "192.0.2.17", stranger)).status).toBe(401);
    expect((await exchangeFrom(limited, "192.0.2.17", fresh)).status).toBe(429);
    expect((await exchangeFrom(limited, "192.0.2.18", fresh)).status).toBe(200);
    expect([...new Set(asked)].toSorted()).toEqual(
      [
        `token:agent:${seeded.agent.id}`,
        `token:agent:${other.agent.id}`,
        `token:agent:${fresh.agent.id}`,
        "token-failed:192.0.2.17",
      ].toSorted(),
    );
  });

  it("[oauth.limit-binding] the Worker's own limiter blocks an address past 60 refused exchanges in a minute", async () => {
    const stranger = { clientId: "nobody", clientSecret: "not-a-secret" };
    // The binding's windows follow the wall clock, so 121 exchanges put 61 in one window however they fall.
    const statuses: number[] = [];
    while (statuses.length < 121 && statuses.at(-1) !== 429)
      statuses.push((await exchangeFrom(worker, "192.0.2.9", stranger)).status);
    expect(statuses.indexOf(429)).toBeGreaterThanOrEqual(60);
    // The refusal is that address's alone.
    expect((await exchangeFrom(worker, "192.0.2.10", stranger)).status).toBe(401);
  });
});
