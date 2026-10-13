import { env } from "cloudflare:workers";
import { AgentNotKnown } from "@keeltown/core/domain/identity";
import { ChangeId, CommitSha, Instant, WorkspaceId } from "@keeltown/core/kernel";
import { makeChangesMemory, makeInboxMemory } from "@keeltown/testing";
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InboxRpc } from "../../src/adapters/driven/do-rpc/inbox.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { AgentSessionCodecs, encodeExit } from "../../src/rpc/index.ts";
import { BASE, type Fetch, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";

/**
 * The work loop end to end through the real HTTP and MCP doorways, the real
 * auth gate and the one handler object, over in-memory Changes and Inbox until
 * the DOs answer their RPC (then these run over `exports.default.fetch`).
 */
function loop(options: { readonly capacity?: number } = {}) {
  const changes = makeChangesMemory(options);
  const inbox = makeInboxMemory();
  const { app } = makeIsolate(
    env,
    isolateLayer(env, {
      changes: changes.layer,
      inbox: inbox.layer,
      notifier: inbox.notifier,
    }),
  );
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  return { changes, inbox, via };
}

const json = { "content-type": "application/json" };
const declareBody = { goal: "Cache permission lookups per request", footprint: [], premises: [] };

interface Declared {
  readonly change: { readonly id: string; readonly state: string };
  readonly lease: { readonly id: string };
  readonly workspace: { readonly id: string; readonly token: string; readonly expiresAt: string };
}

/** Every body these tests read: an agent envelope, or a problem. */
interface Body {
  readonly result: Declared & {
    readonly state: string;
    readonly commitSha: string;
    readonly cursor: string;
    readonly notices: readonly { readonly title: string }[];
  };
  readonly code: string;
  readonly detail: string;
  readonly requestId: string;
  readonly retryAfterMs: number;
  readonly nextActions: readonly unknown[];
}

async function rest(via: Fetch, token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await via(`${BASE}/v1${path}`, { ...init, headers });
  return { status: response.status, headers: response.headers, body: await response.json<Body>() };
}

async function tool(via: Fetch, token: string, name: string, args: Record<string, unknown>) {
  const result = await mcpResult(
    await mcp(token, "tools/call", { name, arguments: args }, name, via),
  );
  return result["structuredContent"];
}

const declare = (via: Fetch, token: string, key: string, body: object = declareBody) =>
  rest(via, token, "/changes", {
    method: "POST",
    headers: { ...json, "idempotency-key": key },
    body: JSON.stringify(body),
  });

const submit = (via: Fetch, token: string, lease: string, key: string, body: object) =>
  rest(via, token, "/submissions", {
    method: "POST",
    headers: { ...json, "idempotency-key": key, "keel-lease": lease },
    body: JSON.stringify(body),
  });

describe("the work loop over REST and MCP", () => {
  it("[a11.declare] declares once per key: the MCP tool replays the REST declare through the same handler", async () => {
    const { via } = loop();
    const token = await tokenFor(await seedAgent());
    const first = await declare(via, token, "declare-key-0001");
    expect(first.status).toBe(201);
    expect(first.body.result).toMatchObject({
      change: { state: "working", revision: 1, goal: declareBody.goal },
      lease: { id: expect.stringMatching(/^lse_/) },
      workspace: { id: expect.stringMatching(/^wsp_/), token: expect.any(String) },
    });
    const replay = await tool(via, token, "declare", {
      "idempotency-key": "declare-key-0001",
      ...declareBody,
    });
    // A retried grant mints a fresh write token with its own expiry; everything else is the same answer.
    expect(replay).toEqual({
      ...first.body,
      result: {
        ...first.body.result,
        workspace: {
          ...first.body.result.workspace,
          token: expect.any(String),
          expiresAt: expect.any(String),
        },
      },
    });
  });

  it("[a11.submit] submits under the lease, and an MCP retry with the same key answers the same", async () => {
    const { via, changes } = loop();
    const token = await tokenFor(await seedAgent());
    const declared = (await declare(via, token, "declare-key-0002")).body.result;
    const sha = CommitSha.make("b".repeat(40));
    changes.push(Schema.decodeUnknownSync(WorkspaceId)(declared.workspace.id), sha);
    const body = { changeId: declared.change.id, commitSha: sha };
    const submitted = await submit(via, token, declared.lease.id, "submit-key-0002", body);
    expect(submitted.status).toBe(202);
    expect(submitted.headers.get("location")).toBe(`/v1/changes/${declared.change.id}/submission`);
    expect(submitted.body.result).toMatchObject({ commitSha: sha, state: "submitted" });
    const retried = await tool(via, token, "submit", {
      "keel-lease": declared.lease.id,
      "idempotency-key": "submit-key-0002",
      ...body,
    });
    expect(retried).toEqual(submitted.body);
  });

  it("[a11.status] answers status alike over REST and MCP, and a waiting read as soon as the change moves", async () => {
    const { via, changes } = loop();
    const token = await tokenFor(await seedAgent());
    const declared = (await declare(via, token, "declare-key-0003")).body.result;
    const changeId = Schema.decodeUnknownSync(ChangeId)(declared.change.id);
    const sha = CommitSha.make("c".repeat(40));
    changes.push(Schema.decodeUnknownSync(WorkspaceId)(declared.workspace.id), sha);
    await submit(via, token, declared.lease.id, "submit-key-0003", { changeId, commitSha: sha });
    const now = await rest(via, token, `/changes/${changeId}/submission?wait=0`);
    expect(now.status).toBe(200);
    expect(await tool(via, token, "status", { changeId, wait: 0 })).toEqual(now.body);
    const started = Date.now();
    const waiting = rest(via, token, `/changes/${changeId}/submission?wait=20`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The read passes the gate and the policy before it waits: the change moves again until it is answered.
    changes.settle(changeId, "landed");
    const settling = setInterval(() => changes.settle(changeId, "landed"), 100);
    const moved = await waiting.finally(() => clearInterval(settling));
    expect(moved.body.result.state).toBe("landed");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("[a11.inbox] reads the inbox alike over REST and MCP, and resumes after the cursor", async () => {
    const { via, inbox } = loop();
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    for (const title of ["Your change was submitted", "Your change landed"])
      inbox.deliver(seeded.agent.id, {
        id: title,
        at: Instant(Date.UTC(2026, 9, 11)),
        kind: "change.moved",
        title,
      });
    const first = await rest(via, token, "/inbox");
    expect(first.body.result.notices.map((n: { title: string }) => n.title)).toEqual([
      "Your change was submitted",
      "Your change landed",
    ]);
    expect(await tool(via, token, "inbox", {})).toEqual(first.body);
    const after = await rest(via, token, `/inbox?cursor=${first.body.result.cursor}`);
    expect(after.body.result.notices).toEqual([]);
  });

  it("[a11.scope-gate] refuses declare to a token holding only agent:read", async () => {
    const { via } = loop();
    const reader = await tokenFor(await seedAgent({}, ["agent:read"]));
    const refused = await declare(via, reader, "declare-key-0005");
    expect(refused.status).toBe(403);
    expect([refused.body.code, refused.body.detail]).toEqual(["auth.forbidden", "Refused: scope."]);
  });

  it("[a11.problems] maps each refusal to its problem code and a way forward", async () => {
    const { via } = loop({ capacity: 1 });
    const token = await tokenFor(await seedAgent());
    const declared = (await declare(via, token, "declare-key-0006")).body.result;
    const conflict = await declare(via, token, "declare-key-0006", {
      ...declareBody,
      goal: "Other",
    });
    const exhausted = await declare(via, token, "declare-key-0007");
    const foreign = await submit(via, token, declared.lease.id, "submit-key-0006", {
      changeId: declared.change.id,
      commitSha: "d".repeat(40),
    });
    const unsubmitted = await rest(via, token, `/changes/${declared.change.id}/submission`);
    const unknown = await rest(via, token, "/changes/chg_01JZ8PT2C4E6G8J0M2N4Q6S8V9/submission");
    const malformed = await rest(via, token, "/changes/not-a-change/submission");
    expect(
      [conflict, exhausted, foreign, unsubmitted, unknown, malformed].map((r) => [
        r.status,
        r.body.code,
      ]),
    ).toEqual([
      [409, "request.idempotency_conflict"],
      [503, "workspace.pool_exhausted"],
      [409, "change.commit_not_in_workspace"],
      [404, "resource.not_found"],
      [404, "change.not_found"],
      [400, "request.invalid"],
    ]);
    expect(exhausted.headers.get("retry-after")).toBe("5");
    expect(exhausted.body.retryAfterMs).toBe(5_000);
    for (const r of [conflict, exhausted, foreign, unsubmitted, unknown])
      expect(r.body.nextActions.length).toBeGreaterThan(0);
  });

  it("[spec.removed] a sketch and a workspace's release are no operations: each path answers 404 as any unknown path does", async () => {
    const { via } = loop({ capacity: 1 });
    const token = await tokenFor(await seedAgent());
    const post = (path: string) =>
      rest(via, token, path, {
        method: "POST",
        headers: { ...json, "idempotency-key": "removed-key-0001" },
        body: "{}",
      });
    const answers = [
      await post("/sketches"),
      await post("/workspaces/wsp_01JZ8PT2C4E6G8J0M2N4Q6S8V0/release"),
      await post("/no-such-operation"),
    ];
    expect(answers.map((r) => [r.status, r.body.code])).toEqual([
      [404, "resource.not_found"],
      [404, "resource.not_found"],
      [404, "resource.not_found"],
    ]);
    // A declare that still names a sketch is refused as any request with a field the contract lacks.
    const declared = await declare(via, token, "removed-key-0002", {
      ...declareBody,
      fromSketch: "sk_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
    });
    expect([declared.status, declared.body.code]).toEqual([400, "request.invalid"]);
  });

  it("[a11.invariant] answers 500 with an incident id when an authenticated agent's AgentSession does not know it", async () => {
    const seeded = await seedAgent();
    const token = await tokenFor(seeded);
    const planted = InboxRpc(() => ({
      inbox: async () =>
        encodeExit(
          AgentSessionCodecs.inbox,
          Exit.fail(new AgentNotKnown({ agentId: seeded.agent.id })),
        ),
    }));
    const { app } = makeIsolate(env, isolateLayer(env, { inbox: planted }));
    const answer = await rest(
      async (url, init) => app.fetch(new Request(url, init), env),
      token,
      "/inbox",
    );
    expect(answer.status).toBe(500);
    expect(answer.body.code).toBe("internal.defect");
    expect(answer.body.detail).toContain(answer.body.requestId);
    expect(Schema.is(Schema.String)(answer.body.requestId)).toBe(true);
  });
});
