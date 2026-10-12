import { openApiDocument } from "@keeltown/contracts";
import { LATTICES } from "@keeltown/core/domain/coordination";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";

function toolNames(result: Record<string, unknown>): string[] {
  const tools: unknown = result["tools"];
  return Array.isArray(tools)
    ? tools.map((tool: unknown) => String(Reflect.get(Object(tool), "name"))).toSorted()
    : [];
}

describe("the published contract, through the Worker's fetch handler", () => {
  it("serves the committed OpenAPI document under /v1, and nowhere else", async () => {
    const response = await exports.default.fetch(`${BASE}/v1/openapi.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual(openApiDocument);
    expect((await exports.default.fetch(`${BASE}/openapi.json`)).status).toBe(404);
  });

  it("refuses an authenticated operation without a token, as problem+json naming the way forward", async () => {
    const response = await exports.default.fetch(`${BASE}/v1/agents/me`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = await response.json<{ code: string; nextActions: { operationId?: string }[] }>();
    expect(body.code).toBe("auth.required");
    expect(body.nextActions.map((a) => a.operationId)).toEqual(["Auth_exchangeToken"]);
  });

  it("names the offending field when a request breaks the contract", async () => {
    const response = await exports.default.fetch(`${BASE}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "c", client_secret: "s" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json<{ code: string; issues: { path: unknown[] }[] }>();
    expect(body.code).toBe("request.invalid");
    expect(body.issues.map((issue) => issue.path)).toContainEqual(["grant_type"]);
  });

  it("answers a stubbed operation with the declared 503 service.not_implemented", async () => {
    const seeded = await seedAgent();
    const response = await exports.default.fetch(
      `${BASE}/v1/verdicts/vrd_01JZ8PT2C4E6G8J0M2N4Q6S8V0`,
      {
        headers: { authorization: `Bearer ${await tokenFor(seeded)}` },
      },
    );
    expect(response.status).toBe(503);
    expect((await response.json<{ code: string }>()).code).toBe("service.not_implemented");
  });

  it("[a11.mcp-gate] lists exactly the mcp-tagged operations as tools, to every caller: the policy decides each call", async () => {
    const tagged = Object.values(openApiDocument.paths)
      .flatMap((path) => Object.values(path))
      .filter(
        (operation): operation is { operationId: string; tags: string[] } =>
          typeof operation === "object" && operation !== null && "tags" in operation,
      )
      .filter((operation) => operation.tags.includes("mcp"))
      .map((operation) => operation.operationId);
    const worker = await seedAgent();
    const reader = await seedAgent({}, ["agent:read"]);
    const all = await mcpResult(await mcp(await tokenFor(worker), "tools/list"));
    const readOnly = await mcpResult(await mcp(await tokenFor(reader), "tools/list"));
    expect(toolNames(all)).toEqual(tagged.toSorted());
    expect(toolNames(readOnly)).toEqual(tagged.toSorted());
  });

  it("[lattice.rest] answers anyone every predicate's lattice, exactly as the domain publishes it", async () => {
    const reader = await tokenFor(await seedAgent({}, ["agent:read"]));
    const anonymous = await exports.default.fetch(`${BASE}/v1/lattices`);
    const response = await exports.default.fetch(`${BASE}/v1/lattices`, {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect([anonymous.status, response.status]).toEqual([200, 200]);
    const items = { items: JSON.parse(JSON.stringify(LATTICES)) };
    expect(await response.json()).toEqual(items);
    expect(await anonymous.json()).toEqual(items);
  });

  it("refuses the MCP endpoint without a token", async () => {
    expect((await mcp(null, "tools/list")).status).toBe(401);
  });
});
