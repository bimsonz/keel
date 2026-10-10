import { openApiDocument } from "@keeltown/contracts";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://keel.localhost";

describe("the HTTP doorway, through the Worker's fetch handler", () => {
  it("serves the committed OpenAPI document", async () => {
    const response = await exports.default.fetch(`${BASE}/openapi.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(openApiDocument);
  });

  it("refuses an authenticated operation without a token, as problem+json", async () => {
    const response = await exports.default.fetch(`${BASE}/v1/agents/me`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = await response.json<{ code: string; nextActions: unknown[] }>();
    expect(body.code).toBe("auth.invalid_token");
    expect(body.nextActions).toEqual([]);
  });

  it("answers an anonymous operation's stub with the declared 503 service.not_implemented", async () => {
    const response = await exports.default.fetch(`${BASE}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "c", client_secret: "s" }),
    });
    expect(response.status).toBe(503);
    expect((await response.json<{ code: string }>()).code).toBe("service.not_implemented");
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

  it("refuses the MCP endpoint without a token", async () => {
    const response = await exports.default.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { host: "keel.localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
