// Withdrawal through the isolate's doorways, REST and MCP, on real Change,
// AgentSession and WorkspacePool DOs. The holder's change is declared over
// REST in a project whose real pool forks from the fake Artifacts namespace,
// so the pool collecting its workspace is observable; the other cases use the
// harness's change (an in-memory pool and code host, a manual clock), reached
// over RPC from the deployed fetch handler as any change is.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { type EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import { Effect, Exit } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { ChangeDO } from "../../src/adapters/driving/do/change.ts";
import type { WorkspacePoolDO } from "../../src/adapters/driving/do/workspace-pool.ts";
import { decodeExit, WorkspacePoolCodecs } from "../../src/rpc/index.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import { followTrunk } from "./pool-harness.ts";
import {
  BASE,
  drainAfter,
  mcp,
  mcpResult,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
} from "./helpers.ts";

/** How long a test waits for something an object does by itself (a fork, a delivery). */
const WAIT = { timeout: 20_000, interval: 25 };

/** Every body these tests read: an agent envelope, or a problem. */
interface Body {
  readonly result: {
    readonly change: { readonly id: string; readonly state: string };
    readonly lease: { readonly id: string };
    readonly workspace: { readonly id: string };
  };
  readonly code: string;
  readonly nextActions: readonly unknown[];
}

async function rest(token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  const response = await exports.default.fetch(`${BASE}/v1${path}`, { ...init, headers });
  return { status: response.status, body: await response.json<Body>() };
}

const abandonRest = (
  token: string,
  changeId: string,
  key: string,
  options: { readonly lease?: string; readonly reason?: string } = {},
) =>
  rest(token, `/changes/${changeId}/abandon`, {
    method: "POST",
    headers: {
      "idempotency-key": key,
      ...(options.lease === undefined ? {} : { "keel-lease": options.lease }),
    },
    body: JSON.stringify(options.reason === undefined ? {} : { reason: options.reason }),
  });

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const result = await mcpResult(await mcp(token, "tools/call", { name, arguments: args }, name));
  return result["structuredContent"];
}

function toolNames(result: Record<string, unknown>): string[] {
  const tools: unknown = result["tools"];
  return Array.isArray(tools)
    ? tools.map((listed: unknown) => String(Reflect.get(Object(listed), "name")))
    : [];
}

/** The change's ChangeWithdrawn, from its log. */
const withdrawal = (log: readonly EventEnvelope[]) => log.find((e) => e.type === "ChangeWithdrawn");

/** A declared change in a project of its own, and a token for the agent holding its lease. */
async function heldChange() {
  const projectId: ProjectId = makeId("prj", ulid());
  const c = await changeUnderTest(projectId);
  const declared = ok(await c.declare());
  const holder = await tokenFor(await seedAgent({ id: c.agentId, projectId }));
  return { c, declared, projectId, holder, lease: declared.change.lease.id };
}

const poolStub = (projectId: ProjectId) =>
  env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(`pool:${projectId}`));

async function poolStatus(projectId: ProjectId) {
  const exit = decodeExit(WorkspacePoolCodecs.status, await poolStub(projectId).status());
  if (Exit.isFailure(exit)) throw new Error(`the pool answered a failure: ${String(exit.cause)}`);
  return exit.value;
}

/**
 * `projectId`'s real pool with one workspace forked from a fresh mirror, as
 * the project's finish leaves it, then held at that: it forks no more, so what it
 * collects is all that moves.
 */
async function stockedPool(projectId: ProjectId) {
  if (env.TEST_ARTIFACTS === undefined) throw new Error("vitest.config.ts binds TEST_ARTIFACTS");
  const mirror = `mirror-${ulid().toLowerCase()}`;
  await env.TEST_ARTIFACTS.create(mirror);
  const source = { namespace: "keel-ws-00", name: mirror };
  const pool = poolStub(projectId);
  // A project's trunk is initialized before its finish configures the pool; this project has none.
  await followTrunk(projectId, source);
  await pool.configure({ source, target: 1 });
  // The refill is a deadline armed for now; the platform may run it before this line does.
  await runDurableObjectAlarm(pool);
  await vi.waitFor(async () => expect((await poolStatus(projectId)).ready).toBe(1), WAIT);
  await pool.configure({ source, target: 0 });
  return pool;
}

describe("abandoning a change through the doorways", () => {
  it("[a11.abandon-holder] the holder withdraws under its lease: 200, the change withdrawn, ChangeWithdrawn by the agent, its workspace collected", async () => {
    const projectId: ProjectId = makeId("prj", ulid());
    const pool = await stockedPool(projectId);
    const agent = await seedAgent({ projectId });
    const token = await tokenFor(agent);
    const declared = await rest(token, "/changes", {
      method: "POST",
      headers: { "idempotency-key": "declare-key-0001" },
      body: JSON.stringify({ goal: "Cache permission lookups per request", premises: [] }),
    });
    const { change, lease, workspace } = declared.body.result;
    // Drained in this order: the change delivers to its agent and pool, the pool to the Projector.
    const changeStub = drainAfter(env.CHANGE.get(env.CHANGE.idFromName(`change:${change.id}`)));
    drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agent.agent.id}`)));
    drainAfter(pool);
    drainAfter(env.LANE.get(env.LANE.idFromName(`lane:${projectId}:main`)));
    const heldBefore = await poolStatus(projectId);

    const withdrawn = await abandonRest(token, change.id, "abandon-key-0001", {
      lease: lease.id,
      reason: "A smaller change does it",
    });
    const log = await runInDurableObject(changeStub, (instance: ChangeDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "change", id: change.id })),
      ),
    );
    await vi.waitFor(async () => {
      const collected = await runInDurableObject(pool, (instance: WorkspacePoolDO) =>
        instance["runtime"].runPromise(
          Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "workspace", id: workspace.id })),
        ),
      );
      expect(collected.at(-1)).toMatchObject({
        type: "WorkspaceCollected",
        payload: { reason: "withdrawn" },
      });
    }, WAIT);

    expect(declared.status).toBe(201);
    expect(heldBefore).toMatchObject({ granted: 1 });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.result.change).toMatchObject({ id: change.id, state: "withdrawn" });
    expect(withdrawal(log)).toMatchObject({
      actor: `agent:${agent.agent.id}`,
      payload: { by: agent.agent.id, reason: "A smaller change does it" },
    });
    await vi.waitFor(
      async () => expect(await poolStatus(projectId)).toMatchObject({ granted: 0 }),
      WAIT,
    );
  });

  it("[a11.abandon-operator] a maintainer of the project's org withdraws with no lease: 200, ChangeWithdrawn by the maintainer, as user:<id>", async () => {
    const { c } = await heldChange();
    const maintainer = await seedUser(uniqueHandle("maintainer"), { role: "maintainer" });
    const { token } = maintainer;

    const withdrawn = await abandonRest(token, c.changeId, "abandon-key-0002");
    const event = withdrawal(await c.log());
    const tools = toolNames(await mcpResult(await mcp(token, "tools/list")));

    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.result.change).toMatchObject({ id: c.changeId, state: "withdrawn" });
    expect((await c.current()).state).toBe("withdrawn");
    expect(event).toMatchObject({
      actor: `user:${maintainer.userId}`,
      payload: { by: maintainer.userId },
    });
    expect(tools).toContain("abandon");
  });

  it("[a11.abandon-stale] another agent's made-up lease, or the holder's after an adoption, is 409 change.lease_stale, and the change carries on", async () => {
    const { c, holder, projectId, lease } = await heldChange();
    const other = await seedAgent({ projectId });
    drainAfter(env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${other.agent.id}`)));
    const otherToken = await tokenFor(other);

    const madeUp = await abandonRest(otherToken, c.changeId, "abandon-key-0003", {
      lease: makeId("lse", ulid()),
    });
    c.clock.advance(LEASE_TTL_MS);
    const adopted = await rest(otherToken, `/changes/${c.changeId}/adopt`, {
      method: "POST",
      headers: { "idempotency-key": "adopt-key-0003" },
    });
    const old = await abandonRest(holder, c.changeId, "abandon-key-0004", { lease });
    const stored = await c.current();

    expect(madeUp.status).toBe(409);
    expect(madeUp.body.code).toBe("change.lease_stale");
    expect(adopted.status).toBe(200);
    expect(old.status).toBe(409);
    expect(old.body.code).toBe("change.lease_stale");
    expect(stored.state).toBe("working");
    expect(stored.lease.id).toBe(adopted.body.result.lease.id);
  });

  it("[a11.abandon-no-lease] an agent that sends no lease is 400 request.invalid, told to send the keel-lease header", async () => {
    const { c, holder, lease } = await heldChange();

    const refused = await abandonRest(holder, c.changeId, "abandon-key-0005");

    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("request.invalid");
    expect(refused.body.nextActions).toEqual([
      expect.objectContaining({
        kind: "call",
        operationId: "abandon",
        title: expect.stringContaining("keel-lease"),
      }),
    ]);
    expect(await c.current()).toMatchObject({ state: "working", lease: { id: lease } });
  });

  it("[a11.abandon-refused] withdrawing a withdrawn change again, under a new key, is 409 change.state_refused", async () => {
    const { c, holder, lease } = await heldChange();

    const first = await abandonRest(holder, c.changeId, "abandon-key-0006", { lease });
    const again = await abandonRest(holder, c.changeId, "abandon-key-0007", { lease });

    expect(first.status).toBe(200);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("change.state_refused");
  });

  it("[a11.abandon-replay] the same key answers the same body; with another reason it is 409 request.idempotency_conflict", async () => {
    const { c, holder, lease } = await heldChange();
    const reason = "A smaller change does it";

    const first = await abandonRest(holder, c.changeId, "abandon-key-0008", { lease, reason });
    const again = await abandonRest(holder, c.changeId, "abandon-key-0008", { lease, reason });
    const conflict = await abandonRest(holder, c.changeId, "abandon-key-0008", {
      lease,
      reason: "Another reason entirely",
    });

    expect(first.status).toBe(200);
    expect(again).toEqual(first);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("request.idempotency_conflict");
  });

  it("[a11.abandon-mcp] the abandon tool withdraws, and its structuredContent equals the REST body for the same withdrawal", async () => {
    const { c, holder, lease } = await heldChange();
    const reason = "A smaller change does it";

    const viaTool = await tool(holder, "abandon", {
      changeId: c.changeId,
      "keel-lease": lease,
      "idempotency-key": "abandon-key-0009",
      reason,
    });
    const viaRest = await abandonRest(holder, c.changeId, "abandon-key-0009", { lease, reason });

    expect(viaTool).toMatchObject({ ok: true, result: { change: { state: "withdrawn" } } });
    expect(viaRest.status).toBe(200);
    expect(viaTool).toEqual(viaRest.body);
  });
});
