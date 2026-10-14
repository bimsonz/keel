import { describe, expect, it } from "vitest";
import {
  issuedTo,
  limitedExchange,
  type TokenLimits,
} from "../../src/adapters/driving/http/token-limits.ts";

/** A token as a provider signs one: only its claims are read here. */
const tokenFor = (sub: string) =>
  ["e30", btoa(JSON.stringify({ sub })).replaceAll("=", ""), "sig"].join(".");

const issued = (sub: string) => async () =>
  Response.json({ access_token: tokenFor(sub), token_type: "Bearer", expires_in: 300 });
const refusedBy = (status: number) => async () =>
  Response.json({ error: "invalid_client" }, { status });

/** Limits allowing each key `allowance`, recording each key asked and each address blocked. */
function allowing(allowance: number) {
  const asked: string[] = [];
  const blocked = new Set<string>();
  const count = async (key: string) => {
    asked.push(key);
    return asked.filter((k) => k === key).length <= allowance;
  };
  const limits: TokenLimits = {
    issued: count,
    failed: count,
    blocks: {
      has: async (address) => blocked.has(address),
      add: async (address) => void blocked.add(address),
    },
  };
  return { limits, asked, blocked };
}

describe("the token limits", () => {
  it("[token-limits.agent] counts each token by the agent it was issued to, however many share an address, and drops one past the agent's limit", async () => {
    const { limits, asked } = allowing(2);
    const statuses: number[] = [];
    for (const sub of ["agt_A", "agt_B", "agt_A", "agt_B", "agt_A"])
      statuses.push((await limitedExchange("192.0.2.1", "r", limits, issued(sub))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    expect(asked).toEqual([
      "token:agent:agt_A",
      "token:agent:agt_B",
      "token:agent:agt_A",
      "token:agent:agt_B",
      "token:agent:agt_A",
    ]);
    const dropped = await limitedExchange("192.0.2.1", "r", limits, issued("agt_A"));
    expect(dropped.headers.get("retry-after")).toBe("60");
    const body = await dropped.text();
    expect(body).toContain("for this agent");
    expect(body).not.toContain("access_token");
  });

  it("[token-limits.failures] counts an address only for its refused exchanges, and refuses it before the provider once past the limit", async () => {
    const { limits, asked, blocked } = allowing(60);
    // A thousand good exchanges from one address, for a thousand agents, are never held to a number.
    for (let i = 0; i < 1000; i++)
      expect((await limitedExchange("192.0.2.2", "r", limits, issued(`agt_${i}`))).status).toBe(
        200,
      );
    expect(blocked.size).toBe(0);
    // A 5xx is Keel's own, never counted against the caller.
    expect((await limitedExchange("192.0.2.2", "r", limits, refusedBy(503))).status).toBe(503);
    expect(asked.filter((k) => k.startsWith("token-failed:"))).toEqual([]);
    // Sixty refusals pass as they came; the sixty-first blocks the address.
    for (let i = 0; i < 61; i++)
      expect((await limitedExchange("192.0.2.2", "r", limits, refusedBy(401))).status).toBe(401);
    expect([...blocked]).toEqual(["192.0.2.2"]);
    let asks = 0;
    const counted = async () => {
      asks += 1;
      return issued("agt_good")();
    };
    const refused = await limitedExchange("192.0.2.2", "r", limits, counted);
    expect([refused.status, refused.headers.get("retry-after"), asks]).toEqual([429, "60", 0]);
    expect(await refused.text()).toContain("from this address");
    // Another address is not held to this one's failures.
    expect((await limitedExchange("192.0.2.3", "r", limits, issued("agt_good"))).status).toBe(200);
  });

  it("[token-limits.issued-to] reads the agent from the token's subject, and nothing from a token without one", () => {
    expect(issuedTo(tokenFor("agt_7JES2JB43X8VPCFQYN25X4BJ9Z"))).toBe(
      "agt_7JES2JB43X8VPCFQYN25X4BJ9Z",
    );
    expect(issuedTo("e30.e30.sig")).toBeUndefined();
    expect(issuedTo("not-a-token")).toBeUndefined();
  });
});
