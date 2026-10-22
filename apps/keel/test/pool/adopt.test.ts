// Adoption through the isolate's doorways, REST and MCP, on a real Change DO:
// the change is the harness's (an in-memory pool and code host, a manual
// clock), reached over RPC from the deployed fetch handler as any change is.
import { heldLease } from "@keeltown/testing";
import { exports } from "cloudflare:workers";
import { LEASE_TTL_MS } from "@keeltown/core/domain/coordination";
import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { BASE, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";

/** A declared change in a project of its own, and a token for another agent of that project. */
async function heldChange() {
  const projectId: ProjectId = makeId("prj", ulid());
  const c = await changeUnderTest(projectId);
  const declared = ok(await c.declare());
  const token = await tokenFor(await seedAgent({ projectId }));
  return { c, declared, projectId, token };
}

const adoptRest = (c: ChangeUnderTest, token: string, key: string) =>
  exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/adopt`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
  });

const adoptTool = async (c: ChangeUnderTest, token: string, key: string) => {
  const result = await mcpResult(
    await mcp(
      token,
      "tools/call",
      { name: "adopt", arguments: { changeId: c.changeId, "idempotency-key": key } },
      "adopt",
    ),
  );
  // A failure's body is not the tool's outputSchema, so it rides only as the text mirror.
  const [first] = Array.isArray(result["content"]) ? result["content"] : [];
  const text: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "text") : "";
  return result["structuredContent"] ?? (typeof text === "string" ? JSON.parse(text) : undefined);
};

describe("adopting a change through the doorways", () => {
  it("[b11.adopt] after the lease lapses, REST adopts it with a new lease and a workspace token; MCP's retry with the key answers the same", async () => {
    const { c, declared, token } = await heldChange();
    c.clock.advance(LEASE_TTL_MS);

    const response = await adoptRest(c, token, "adopt-key-0001");
    const body = await response.json<{
      ok: boolean;
      result: {
        change: { id: string; agentId: string };
        lease: { id: string };
        workspace?: { id: string; token?: string };
      };
      next: { operationId?: string }[];
    }>();
    const replayed = await adoptTool(c, token, "adopt-key-0001");
    const stored = await c.current();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.lease.id).not.toBe(heldLease(declared.change).id);
    expect(body.result.lease.id).toBe(heldLease(stored).id);
    expect(body.result.change).toMatchObject({ id: c.changeId, agentId: stored.agentId });
    expect(stored.agentId).not.toBe(declared.change.agentId);
    expect(body.result.workspace?.id).toBe(declared.grant.workspaceId);
    expect(body.result.workspace?.token).toEqual(expect.any(String));
    expect(replayed).toMatchObject({ ok: true, result: { lease: { id: heldLease(stored).id } } });
  });

  it("[b11.adopt-early] refuses MCP's adopt while the lease is alive: 409 change.lease_not_lapsed, waiting until it lapses", async () => {
    const { c, declared, token } = await heldChange();

    const refused = await adoptTool(c, token, "adopt-key-0002");
    const rest = await adoptRest(c, token, "adopt-key-0003");
    const problem = await rest.json<{ code: string; nextActions: { kind: string }[] }>();

    expect(refused).toMatchObject({ code: "change.lease_not_lapsed", status: 409 });
    expect(rest.status).toBe(409);
    expect(problem.code).toBe("change.lease_not_lapsed");
    expect(problem.nextActions).toEqual([expect.objectContaining({ kind: "wait" })]);
    expect(heldLease(await c.current()).id).toBe(heldLease(declared.change).id);
  });

  it("[b11.adopt-foreign] refuses an agent bound to another project with 403, though the lease lapsed", async () => {
    const { c, declared } = await heldChange();
    const foreign = await tokenFor(await seedAgent({ projectId: makeId("prj", ulid()) }));
    c.clock.advance(LEASE_TTL_MS);

    const response = await adoptRest(c, foreign, "adopt-key-0004");
    const problem = await response.json<{ code: string; detail: string }>();

    expect(response.status).toBe(403);
    expect(problem.code).toBe("auth.forbidden");
    expect(problem.detail).toMatch(/^Refused: foreign-project\. /);
    expect(heldLease(await c.current()).id).toBe(heldLease(declared.change).id);
  });

  it("[b11.adopt-replay] answers the key from another agent with 409 request.idempotency_conflict", async () => {
    const { c, projectId, token } = await heldChange();
    const other = await tokenFor(await seedAgent({ projectId }));
    c.clock.advance(LEASE_TTL_MS);

    const first = await adoptRest(c, token, "adopt-key-0005");
    const conflict = await adoptRest(c, other, "adopt-key-0005");
    const problem = await conflict.json<{ code: string }>();

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(problem.code).toBe("request.idempotency_conflict");
  });
});
