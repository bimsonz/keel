// Rebasing through the isolate's doorways, REST and MCP, on a real Change DO:
// the change is the harness's (an in-memory pool, code host, Trunk head and
// rebaser), reached over RPC from the deployed fetch handler as any change is.
// Trunk has moved past the change's base, as it has after a textual bounce.
import { heldLease } from "@keeltown/testing";
import { exports } from "cloudflare:workers";
import { projectRepos } from "@keeltown/core/application/integration";
import { type CommitSha, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost, KEEL_TRUNK_REF } from "@keeltown/core/ports";
import { Effect } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { BASE, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";

/** A declared change in a project of its own whose trunk has moved on, its workspace, and a token for its own agent. */
async function bouncedOntoMovedTrunk() {
  const projectId: ProjectId = makeId("prj", ulid());
  const c = await changeUnderTest(projectId);
  const declared = ok(await c.declare());
  const trunk = projectRepos(projectId).trunk;
  const landed = await Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* CodeHost;
      yield* host.create(declared.grant.repo);
      yield* host.create(trunk);
      return yield* c.code.fixture.commit(trunk, "refs/heads/main", { "README.md": "landed\n" });
    }).pipe(Effect.provide(c.code.layer)),
  );
  c.trunks.heads.set(projectId, landed);
  const token = await tokenFor(await seedAgent({ projectId, id: c.agentId }));
  return { c, declared, landed, token };
}

const rebaseRest = (c: ChangeUnderTest, token: string, lease: string, key: string) =>
  exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/rebase`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "keel-lease": lease, "idempotency-key": key },
  });

const rebaseTool = async (c: ChangeUnderTest, token: string, lease: string, key: string) => {
  const result = await mcpResult(
    await mcp(
      token,
      "tools/call",
      {
        name: "rebase",
        arguments: { changeId: c.changeId, "keel-lease": lease, "idempotency-key": key },
      },
      "rebase",
    ),
  );
  // A failure's body is not the tool's outputSchema, so it rides only as the text mirror.
  const [first] = Array.isArray(result["content"]) ? result["content"] : [];
  const text: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "text") : "";
  return result["structuredContent"] ?? (typeof text === "string" ? JSON.parse(text) : undefined);
};

const keelTrunkOf = (c: ChangeUnderTest, repo: { namespace: string; name: string }) =>
  Effect.runPromise(
    Effect.flatMap(CodeHost, (host) => host.head(repo, KEEL_TRUNK_REF)).pipe(
      Effect.provide(c.code.layer),
    ),
  );

describe("rebasing a change through the doorways", () => {
  it("[rebase.rest] REST puts trunk's head on the workspace's keel/trunk and moves the base; MCP's retry with the key answers the same", async () => {
    const { c, declared, landed, token } = await bouncedOntoMovedTrunk();
    const lease = heldLease(declared.change).id;

    const response = await rebaseRest(c, token, lease, "rebase-key-0001");
    const body = await response.json<{
      ok: boolean;
      result: { change: { id: string }; ref: string; base: CommitSha };
      next: { operationId?: string; title: string }[];
    }>();
    const replayed = await rebaseTool(c, token, lease, "rebase-key-0001");

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      result: { change: { id: c.changeId }, ref: KEEL_TRUNK_REF, base: landed },
    });
    expect(body.next).toEqual([
      expect.objectContaining({
        operationId: "submit",
        title: expect.stringContaining("git fetch origin keel/trunk && git merge FETCH_HEAD"),
      }),
    ]);
    expect((await c.current()).baseSha).toBe(landed);
    expect(await keelTrunkOf(c, declared.grant.repo)).toBe(landed);
    expect(c.rebaser.pushed).toHaveLength(1);
    expect(replayed).toMatchObject({ ok: true, result: { base: landed } });
  });

  it("[rebase.rest-refused] a stale lease is 409 change.lease_stale, and nothing is pushed", async () => {
    const { c, token } = await bouncedOntoMovedTrunk();

    const response = await rebaseRest(c, token, makeId("lse", ulid()), "rebase-key-0002");
    const body = await response.json<{ code: string }>();

    expect(response.status).toBe(409);
    expect(body.code).toBe("change.lease_stale");
    expect(c.rebaser.pushed).toEqual([]);
  });
});
