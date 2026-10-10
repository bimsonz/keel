// The live whoami smoke: one agent's identity, asked over REST and over MCP
// against a deployed Keel, must come back identical. Plain fetch only; no
// Keel internals, so it exercises exactly what an outside agent would.

export interface Credential {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface WhoamiSmokeResult {
  readonly rest: unknown;
  readonly tool: unknown;
  /** Milliseconds per call, in order: token, REST, MCP. */
  readonly timings: { readonly token: number; readonly rest: number; readonly mcp: number };
}

const MCP_PROTOCOL_VERSION = "2026-07-28";

async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await run();
  return [value, Math.round(performance.now() - started)];
}

async function expectOk(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what} answered ${response.status}: ${text.slice(0, 400)}`);
  return text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "null");
}

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

export async function whoamiSmoke(keelUrl: string, credential: Credential): Promise<WhoamiSmokeResult> {
  const [token, tokenMs] = await timed(async () => {
    const response = await fetch(`${keelUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: credential.clientId, client_secret: credential.clientSecret }),
    });
    const accessToken = field(await expectOk(response, "token exchange"), "access_token");
    if (typeof accessToken !== "string") throw new Error("token exchange returned no access_token");
    return accessToken;
  });

  const [rest, restMs] = await timed(async () =>
    expectOk(await fetch(`${keelUrl}/v1/agents/me`, { headers: { authorization: `Bearer ${token}` } }), "GET /v1/agents/me"),
  );

  const [result, mcpMs] = await timed(async () => {
    const response = await fetch(`${keelUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "whoami",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "whoami",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "keel-smoke", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    return field(await expectOk(response, "MCP tools/call whoami"), "result");
  });
  if (field(result, "isError") === true) throw new Error(`MCP whoami returned an error: ${JSON.stringify(result)}`);

  return { rest, tool: field(result, "structuredContent"), timings: { token: tokenMs, rest: restMs, mcp: mcpMs } };
}
