import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { type Agent, type Scope } from "@keeltown/core/domain/identity";
import { Instant, makeId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { hashSecret } from "@keeltown/testing";
import { Effect } from "effect";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { AgentDirectory } from "@keeltown/core/ports";

export const BASE = "https://keel.localhost";

export interface SeededAgent {
  readonly agent: Agent;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Writes an agent and its credential into the D1 projection, as enrolment's projector will. */
export async function seedAgent(overrides: Partial<Agent> = {}, scopes: readonly Scope[] = ["agent:read", "agent:work"]): Promise<SeededAgent> {
  const agent: Agent = {
    id: makeId("agt", ulid()),
    name: "pool-agent",
    kind: "interactive",
    scopes,
    state: "active",
    revocationEpoch: 0,
    createdAt: Instant(Date.UTC(2026, 9, 10)),
    ...overrides,
  };
  const clientId = `client-${crypto.randomUUID()}`;
  const clientSecret = `secret-${crypto.randomUUID()}`;
  const secretHash = await hashSecret(clientSecret);
  await Effect.runPromise(
    AgentDirectory.use((d) => d.upsert(agent, { clientId, agentId: agent.id, secretHash })).pipe(Effect.provide(AgentDirectoryD1(env.DB))),
  );
  return { agent, clientId, clientSecret };
}

export async function exchange(seeded: SeededAgent, scope?: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: seeded.clientId,
      client_secret: seeded.clientSecret,
      ...(scope === undefined ? {} : { scope }),
    }),
  });
}

export async function tokenFor(seeded: SeededAgent, scope?: string): Promise<string> {
  const response = await exchange(seeded, scope);
  if (response.status !== 200) throw new Error(`token exchange answered ${response.status}: ${await response.text()}`);
  return (await response.json<{ access_token: string }>()).access_token;
}

const MCP_PROTOCOL_VERSION = "2026-07-28";

/** One stateless MCP request, with the headers the 2026-07-28 transport requires. */
export async function mcp(token: string | null, method: string, params: Record<string, unknown> = {}, name?: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      host: "keel.localhost",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "keel-pool-test", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

/** The JSON-RPC result of an MCP response, whether it came back as JSON or as one SSE event. */
export async function mcpResult(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const json = text.startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}");
  const message: unknown = JSON.parse(json);
  const result: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "result") : undefined;
  if (typeof result !== "object" || result === null) throw new Error(`MCP error: ${json}`);
  return Object.fromEntries(Object.entries(result));
}
