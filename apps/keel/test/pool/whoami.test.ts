import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, exchange, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";

/** The exemplar vertical, end to end through the real fetch handler: token → REST → MCP. */
describe("whoami", () => {
  it("exchanges client credentials for a bearer token carrying the agent's scopes", async () => {
    const seeded = await seedAgent();
    const response = await exchange(seeded);
    expect(response.status).toBe(200);
    const body = await response.json<{
      token_type: string;
      scope: string;
      expires_in: number;
      access_token: string;
    }>();
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("agent:read agent:work");
    expect(body.expires_in).toBe(3600);
    expect(body.access_token.split(".")).toHaveLength(3);
  });

  it("refuses a wrong secret with invalid_client, and an unheld scope with invalid_scope", async () => {
    const seeded = await seedAgent({}, ["agent:read"]);
    const wrong = await exchange({ ...seeded, clientSecret: "not-the-secret" });
    expect(wrong.status).toBe(401);
    expect((await wrong.json<{ error: string }>()).error).toBe("invalid_client");
    const unheld = await exchange(seeded, "operator");
    expect(unheld.status).toBe(400);
    expect((await unheld.json<{ error: string }>()).error).toBe("invalid_scope");
  });

  it("answers REST with the agent, in the agent envelope", async () => {
    const seeded = await seedAgent({ name: "rest-agent" });
    const response = await exports.default.fetch(`${BASE}/v1/agents/me`, {
      headers: { authorization: `Bearer ${await tokenFor(seeded)}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      ok: boolean;
      result: { agent: { id: string; name: string; scopes: string[] }; session: unknown };
    }>();
    expect(body.ok).toBe(true);
    expect(body.result.agent).toMatchObject({
      id: seeded.agent.id,
      name: "rest-agent",
      scopes: ["agent:read", "agent:work"],
    });
    expect(body.result.session).toBeNull();
  });

  it("answers the MCP tool with exactly the REST body, through the same handler", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    const rest = await (
      await exports.default.fetch(`${BASE}/v1/agents/me`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    const tool = await mcpResult(
      await mcp(token, "tools/call", { name: "whoami", arguments: {} }, "whoami"),
    );
    expect(tool["isError"]).not.toBe(true);
    expect(tool["structuredContent"]).toEqual(rest);
  });

  it("[a11s.whoami] echoes the token's sponsor and the agent's, the MCP tool equal to REST", async () => {
    const seeded = await seedAgent({ onBehalfOf: "github:bimsonz" });
    const token = await tokenFor(seeded);
    const rest = await (
      await exports.default.fetch(`${BASE}/v1/agents/me`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<{ result: { onBehalfOf?: string; agent: { onBehalfOf?: string } } }>();
    expect(rest.result.onBehalfOf).toBe("github:bimsonz");
    expect(rest.result.agent.onBehalfOf).toBe("github:bimsonz");
    const tool = await mcpResult(
      await mcp(token, "tools/call", { name: "whoami", arguments: {} }, "whoami"),
    );
    expect(tool["structuredContent"]).toEqual(rest);
    const bare = await (
      await exports.default.fetch(`${BASE}/v1/agents/me`, {
        headers: { authorization: `Bearer ${await tokenFor(await seedAgent())}` },
      })
    ).json<{ result: Record<string, unknown> }>();
    expect("onBehalfOf" in bare.result).toBe(false);
  });

  it("refuses a token minted before the agent's revocation epoch moved, as auth.revoked", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    await env.DB.prepare("UPDATE agents SET revocation_epoch = revocation_epoch + 1 WHERE id = ?")
      .bind(seeded.agent.id)
      .run();
    const response = await exports.default.fetch(`${BASE}/v1/agents/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    expect((await response.json<{ code: string }>()).code).toBe("auth.revoked");
  });

  it("refuses a token signed by another key", async () => {
    const seeded = await seedAgent();
    const [header, payload] = (await tokenFor(seeded)).split(".");
    const forged = `${header}.${payload}.${"A".repeat(86)}`;
    const response = await exports.default.fetch(`${BASE}/v1/agents/me`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.status).toBe(401);
    expect((await response.json<{ code: string }>()).code).toBe("auth.invalid_token");
  });
});
