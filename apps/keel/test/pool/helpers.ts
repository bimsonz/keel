import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { type Agent, type Role, type Scope } from "@keeltown/core/domain/identity";
import { PROJECT, ProjectRecord } from "@keeltown/core/application/integration";
import { Instant, makeId, OrgId, type ProjectId, UserId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { hashSecret, sampleProjectId } from "@keeltown/testing";
import { Effect, Schema } from "effect";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { AgentDirectory, EntityStore } from "@keeltown/core/ports";
import { expect, vi } from "vitest";
import { armedAlarms } from "../../src/adapters/driving/do/alarm.ts";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { OUTBOX_FLUSH, OUTBOX_REDELIVERY } from "../../src/adapters/driving/do/keel-object.ts";

export const BASE = "https://keel.localhost";

export interface SeededAgent {
  readonly agent: Agent;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * The tenant pool agents live in unless a test says otherwise: org `pool`,
 * owned by the user who sponsors them, as the cutover leaves every agent.
 */
export const POOL_ORG = Schema.decodeSync(OrgId)("org_01M4P00000000000000000000A");
export const POOL_SPONSOR = Schema.decodeSync(UserId)("usr_01M4P00000000000000000000S");

/** A second tenant, org `elsewhere`, for what a caller outside org `pool` sees. */
export const OTHER_ORG = Schema.decodeSync(OrgId)("org_01M4P00000000000000000000B");
export const OTHER_SPONSOR = Schema.decodeSync(UserId)("usr_01M4P00000000000000000000T");

/** Better Auth's rows for a user, as its D1 adapter writes them (dates as ISO text). */
async function insertUser(userId: string, handle: string, admin = false): Promise<void> {
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username, role)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(userId, handle, `${handle}@users.keel.invalid`, at, at, handle, admin ? "admin" : null)
    .run();
}

/** An org and a member of it, written as Better Auth writes them; each is kept if already there. */
export async function seedOrg(
  org: OrgId,
  slug: string,
  owner: UserId,
  ownerHandle: string,
): Promise<void> {
  await insertUser(owner, ownerHandle);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`,
    ).bind(org, slug, slug, new Date().toISOString()),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       SELECT ?, ?, ?, 'owner', ? WHERE NOT EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`,
    ).bind(ulid(), org, owner, new Date().toISOString(), org, owner),
  ]);
}

/** A project's place in an org, as project creation (or the cutover's move) writes it. */
export async function placeProject(
  projectId: ProjectId | string,
  org: OrgId = POOL_ORG,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO projects (id, org_id, name, created_at) VALUES (?, ?, ?, 0)`,
  )
    .bind(projectId, org, projectId.toLowerCase())
    .run();
}

const encodeProjectRecord = Schema.encodeSync(ProjectRecord);

/**
 * A project its Project DO holds, as createProject leaves its record: its
 * settings the defaults (private) until a PUT changes them. With a place, it
 * is a project the policy sees. A project already created is left as it is.
 */
export async function establishProject(projectId: ProjectId): Promise<void> {
  const stub = env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`));
  await runInDurableObject(stub, (instance: ProjectDO) =>
    instance["runtime"].runPromise(
      EntityStore.use((store) =>
        Effect.sync(() => {
          if (store.get(PROJECT, projectId) !== undefined) return;
          const record = { id: projectId, name: "pool-project", createdAt: Instant(0) };
          store.put(PROJECT, projectId, JSON.parse(JSON.stringify(encodeProjectRecord(record))));
        }),
      ),
    ),
  );
}

/**
 * Writes an agent and its credential into the D1 projection, as enrolment's
 * projector will: in org `pool`, sponsored by its owner, its project placed
 * there and held by its Project DO, so the policy sees it. `placed: false`
 * writes an agent enrolled before tenancy, with neither.
 */
export async function seedAgent(
  overrides: Partial<Agent> = {},
  scopes: readonly Scope[] = ["agent:read", "agent:work"],
  options: { readonly placed?: boolean } = {},
): Promise<SeededAgent> {
  const placed = options.placed ?? true;
  if (placed) await seedOrg(POOL_ORG, "pool", POOL_SPONSOR, "pool-sponsor");
  const agent: Agent = {
    id: makeId("agt", ulid()),
    projectId: sampleProjectId,
    name: "pool-agent",
    kind: "interactive",
    scopes,
    state: "active",
    revocationEpoch: 0,
    createdAt: Instant(Date.UTC(2026, 9, 10)),
    ...(placed ? { org: POOL_ORG, sponsor: POOL_SPONSOR } : {}),
    ...overrides,
  };
  if (placed && agent.org !== undefined) {
    await placeProject(agent.projectId, agent.org);
    await establishProject(agent.projectId);
  }
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

/** An agent of org `elsewhere`, sponsored by its owner, in a project of its own placed there. */
export async function seedForeignAgent(
  overrides: Partial<Agent> = {},
  scopes: readonly Scope[] = ["agent:read", "agent:work"],
): Promise<SeededAgent> {
  await seedOrg(OTHER_ORG, "elsewhere", OTHER_SPONSOR, "elsewhere-owner");
  return seedAgent(
    { org: OTHER_ORG, sponsor: OTHER_SPONSOR, projectId: makeId("prj", ulid()), ...overrides },
    scopes,
  );
}

/** A handle no other user in the file holds: `prefix` and a random tail. */
export const uniqueHandle = (prefix: string): string =>
  `${prefix}-${ulid().toLowerCase().slice(-12)}`;

/** A signed-in user: a Better Auth session presented as a bearer. */
export interface SeededUser {
  readonly userId: UserId;
  readonly handle: string;
  /** `Authorization: Bearer <token>`. */
  readonly token: string;
}

/**
 * A user with a session, written as Better Auth writes them, and a member of
 * `org` (org `pool` by default; `pool` and `elsewhere` are seeded if need be)
 * with `role` unless `role` is null.
 */
export async function seedUser(
  handle: string,
  options: { readonly role?: Role | null; readonly org?: OrgId; readonly admin?: boolean } = {},
): Promise<SeededUser> {
  const org = options.org ?? POOL_ORG;
  if (org === POOL_ORG) await seedOrg(POOL_ORG, "pool", POOL_SPONSOR, "pool-sponsor");
  if (org === OTHER_ORG) await seedOrg(OTHER_ORG, "elsewhere", OTHER_SPONSOR, "elsewhere-owner");
  const userId = makeId("usr", ulid());
  await insertUser(userId, handle, options.admin === true);
  const at = new Date().toISOString();
  const token = crypto.randomUUID().replaceAll("-", "");
  const role = options.role === undefined ? "member" : options.role;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(ulid(), new Date(Date.now() + 3_600_000).toISOString(), token, at, at, userId),
    ...(role === null
      ? []
      : [
          env.DB.prepare(
            `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`,
          ).bind(ulid(), org, userId, role, at),
        ]),
  ]);
  return { userId, handle, token };
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
