import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
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
  it("[oauth.rate-limit] asks the limiter about each exchange, keyed by address alone, and refuses what it refuses ahead of the exchange", async () => {
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
    const stranger = { clientId: "nobody", clientSecret: "not-a-secret" };

    // The first of the allowance shows the credentials are good; another client's bad ones spend the rest.
    const statuses = [(await exchangeFrom(limited, "192.0.2.7", seeded)).status];
    for (let i = 1; i < 60; i++)
      statuses.push((await exchangeFrom(limited, "192.0.2.7", stranger)).status);
    expect(statuses[0]).toBe(200);
    expect(statuses.filter((status) => status === 429)).toEqual([]);

    // Past it, the same good credentials are refused: the limiter answers, not the exchange.
    const refused: Response[] = [];
    for (let i = 0; i < 3; i++) refused.push(await exchangeFrom(limited, "192.0.2.7", seeded));
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
        detail: expect.stringMatching(/wait a minute/),
      });
    }

    // Another address, and a request the edge named no address for, have allowances of their own.
    expect((await exchangeFrom(limited, "192.0.2.8", seeded)).status).toBe(200);
    expect((await exchangeFrom(limited, null, seeded)).status).toBe(200);
    expect([...new Set(asked)]).toEqual(["token:192.0.2.7", "token:192.0.2.8", "token:unknown"]);
    expect(asked.filter((key) => key === "token:192.0.2.7")).toHaveLength(63);
  });

  it("[oauth.limit-binding] the Worker's own limiter refuses an address past 60 exchanges in a minute", async () => {
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
