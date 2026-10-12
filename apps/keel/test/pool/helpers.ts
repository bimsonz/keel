import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { type Agent, type Scope } from "@keeltown/core/domain/identity";
import { Instant, makeId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { hashSecret, sampleProjectId } from "@keeltown/testing";
import { Effect } from "effect";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { AgentDirectory } from "@keeltown/core/ports";
import { expect, vi } from "vitest";
import { armedAlarms } from "../../src/adapters/driving/do/alarm.ts";
import { OUTBOX_FLUSH, OUTBOX_REDELIVERY } from "../../src/adapters/driving/do/keel-object.ts";

export const BASE = "https://keel.localhost";

export interface SeededAgent {
  readonly agent: Agent;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Writes an agent and its credential into the D1 projection, as enrolment's projector will. */
export async function seedAgent(
  overrides: Partial<Agent> = {},
  scopes: readonly Scope[] = ["agent:read", "agent:work"],
): Promise<SeededAgent> {
  const agent: Agent = {
    id: makeId("agt", ulid()),
    projectId: sampleProjectId,
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
    AgentDirectory.use((d) => d.upsert(agent, { clientId, agentId: agent.id, secretHash })).pipe(
      Effect.provide(AgentDirectoryD1(env.DB)),
    ),
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
  if (response.status !== 200)
    throw new Error(`token exchange answered ${response.status}: ${await response.text()}`);
  return (await response.json<{ access_token: string }>()).access_token;
}

const MCP_PROTOCOL_VERSION = "2026-07-28";

/** One stateless MCP request, with the headers the 2026-07-28 transport requires. */
/** How a test reaches a Worker: the deployed fetch handler by default, or an app built over test Layers. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const worker: Fetch = (url, init) => exports.default.fetch(url, init);

export async function mcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
  via: Fetch = worker,
): Promise<Response> {
  return via(`${BASE}/mcp`, {
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
  const json = text.startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6) ?? "{}");
  const message: unknown = JSON.parse(json);
  const result: unknown =
    typeof message === "object" && message !== null ? Reflect.get(message, "result") : undefined;
  if (typeof result !== "object" || result === null) throw new Error(`MCP error: ${json}`);
  return Object.fromEntries(Object.entries(result));
}

/**
 * Waits until `stub`'s outbox is quiet: nothing owed to any subscriber and no
 * flush or redelivery armed. Every object owes the Projector a delivery after
 * each commit, flushed by a debounce a moment later. A test that commits real
 * events and ends before that flush runs leaves it to outlive the test file,
 * which fails the run with an unhandled teardown error even when every test
 * passed. A delivery is deleted only once its subscriber took it, so an empty
 * table means the last one arrived.
 */
export async function drainOutbox(stub: DurableObjectStub, timeout = 20_000): Promise<void> {
  await vi.waitFor(
    async () => {
      const outbox = await runInDurableObject(stub, (_instance: unknown, state) => ({
        owed: state.storage.sql.exec("SELECT event_id FROM keel_deliveries").toArray().length,
        armed: armedAlarms(state.storage)
          .map((alarm) => alarm.reason)
          .filter((reason) => reason === OUTBOX_FLUSH || reason === OUTBOX_REDELIVERY),
      }));
      expect(outbox).toEqual({ owed: 0, armed: [] });
    },
    { timeout, interval: 25 },
  );
}

/** The objects to drain when the running case ends, by id. Each test file loads its own copy of this module. */
const toDrain = new Map<string, DurableObjectStub>();

/**
 * Registers `stub` to be drained when the running case ends, and returns it.
 * Stub helpers call it, so a case that commits real events cannot end with a
 * flush still owed: `drainRegistered` runs after every case (setup.ts).
 */
export function drainAfter<S extends DurableObjectStub>(stub: S): S {
  toDrain.set(stub.id.toString(), stub);
  return stub;
}

/**
 * Drains every object registered since the last call, in the order they were
 * registered, then forgets them. In order, because an object drained first
 * delivers to those registered after it (a change to its agent, pool and
 * lane), whose reactions may then owe a flush of their own.
 */
export async function drainRegistered(): Promise<void> {
  const stubs = [...toDrain.values()];
  toDrain.clear();
  for (const stub of stubs) await drainOutbox(stub);
}

/**
 * Drops what `stub` owes `subscriber`: a waiting Workflow instance a test
 * names without running it. A send to an instance that does not exist fails,
 * so the delivery stays owed and its object's outbox would never go quiet.
 */
export const forgetOwed = (stub: DurableObjectStub, subscriber: string) =>
  runInDurableObject(stub, (_instance: unknown, state) => {
    state.storage.sql.exec("DELETE FROM keel_deliveries WHERE subscriber = ?", subscriber);
  });
