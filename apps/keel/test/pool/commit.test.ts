// Committing through the isolate's doorways, REST and MCP, on a real Change
// DO: the change is the harness's (an in-memory pool, code host and writer),
// reached over RPC from the deployed fetch handler as any change is.
import { exports } from "cloudflare:workers";
import { type CommitSha, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import { Effect } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import { BASE, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";

/** A declared change whose workspace holds one commit on main, a token for its own agent, and one for another agent of its project. */
async function declaredWithWorkspace() {
  const projectId: ProjectId = makeId("prj", ulid());
  const c = await changeUnderTest(projectId);
  const declared = ok(await c.declare());
  const head = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(declared.grant.repo);
      return yield* c.code.fixture.commit(declared.grant.repo, "refs/heads/main", {
        "README.md": "base\n",
        "src/a.ts": "export const a = 1;\n",
      });
    }).pipe(Effect.provide(c.code.layer)),
  );
  const token = await tokenFor(await seedAgent({ projectId, id: c.agentId }));
  const other = await tokenFor(await seedAgent({ projectId }));
  return { c, declared, head, token, other };
}

const request = (expectedHead: CommitSha) => ({
  expectedHead,
  message: "Raise a",
  edits: [{ path: "src/a.ts", content: "export const a = 2;\n" }],
});

const commitRest = (c: ChangeUnderTest, token: string, lease: string, key: string, body: object) =>
  exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/commits`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "keel-lease": lease,
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });

const commitTool = async (
  c: ChangeUnderTest,
  token: string,
  lease: string,
  key: string,
  body: object,
) =>
  (
    await mcpResult(
      await mcp(
        token,
        "tools/call",
        {
          name: "commit",
          arguments: { changeId: c.changeId, "keel-lease": lease, "idempotency-key": key, ...body },
        },
        "commit",
      ),
    )
  )["structuredContent"];

const headOf = (c: ChangeUnderTest, repo: { namespace: string; name: string }) =>
  Effect.runPromise(
    Effect.flatMap(CodeHost, (host) => host.head(repo, "refs/heads/main")).pipe(
      Effect.provide(c.code.layer),
    ),
  );

interface CommitBody {
  readonly ok: boolean;
  readonly result: {
    readonly commitSha: string;
    readonly parent: string;
    readonly tree: string;
    readonly changed: number;
  };
  readonly next: readonly { readonly operationId?: string }[];
}

describe("committing to a change's workspace through the doorways", () => {
  it("[commit.rest] REST commits the edits on the head and offers submit; MCP's call with the same edits answers the same commit", async () => {
    const { c, declared, head, token } = await declaredWithWorkspace();
    const lease = declared.change.lease.id;

    const response = await commitRest(c, token, lease, "commit-key-0001", request(head));
    const body = await response.json<CommitBody>();
    const tool = await commitTool(c, token, lease, "commit-key-0001", request(head));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, result: { parent: head, changed: 1 } });
    expect(body.next.map((n) => n.operationId)).toEqual(["submit"]);
    expect(await headOf(c, declared.grant.repo)).toBe(body.result.commitSha);
    expect(c.writer.committed).toHaveLength(1);
    const { commitSha, parent, tree, changed } = body.result;
    expect(tool).toMatchObject({ ok: true, result: { commitSha, parent, tree, changed } });
  });

  it("[commit.rest-refused] a stale lease is 409 change.lease_stale and an edit with both content and delete is 400, and nothing is written", async () => {
    const { c, declared, head, token } = await declaredWithWorkspace();

    const stale = await commitRest(
      c,
      token,
      makeId("lse", ulid()),
      "commit-key-0002",
      request(head),
    );
    const both = await commitRest(c, token, declared.change.lease.id, "commit-key-0003", {
      ...request(head),
      edits: [{ path: "src/a.ts", content: "x", delete: true }],
    });

    expect([stale.status, (await stale.json<{ code: string }>()).code]).toEqual([
      409,
      "change.lease_stale",
    ]);
    expect(both.status).toBe(400);
    expect(c.writer.committed).toEqual([]);
    expect(await headOf(c, declared.grant.repo)).toBe(head);
  });

  it("[commit.rest-head-moved] a commit on a head that moved is 409 workspace.head_moved naming the head now, and nothing is written", async () => {
    const { c, declared, head, token } = await declaredWithWorkspace();
    const lease = declared.change.lease.id;

    const first = await (
      await commitRest(c, token, lease, "commit-key-0004", request(head))
    ).json<CommitBody>();
    const moved = await commitRest(c, token, lease, "commit-key-0005", {
      ...request(head),
      edits: [{ path: "src/b.ts", content: "export const b = 1;\n" }],
    });
    const problem = await moved.json<{
      code: string;
      nextActions: readonly { operationId?: string; title: string }[];
    }>();

    expect([moved.status, problem.code]).toEqual([409, "workspace.head_moved"]);
    expect(problem.nextActions[0]).toMatchObject({ operationId: "commit" });
    expect(problem.nextActions[0]?.title).toContain(first.result.commitSha);
    expect(c.writer.committed).toHaveLength(1);
    expect(await headOf(c, declared.grant.repo)).toBe(first.result.commitSha);
  });

  it("[commit.rest-own] another agent of the project, holding the lease, is 404 change.not_found, and nothing is written", async () => {
    const { c, declared, head, other } = await declaredWithWorkspace();

    const response = await commitRest(
      c,
      other,
      declared.change.lease.id,
      "commit-key-0006",
      request(head),
    );

    expect([response.status, (await response.json<{ code: string }>()).code]).toEqual([
      404,
      "change.not_found",
    ]);
    expect(c.writer.committed).toEqual([]);
  });

  it("[commit.rest-decides-again] an abandon that lands on the Change DO while the commit is pushed answers the commit 409 change.state_refused, not its commit", async () => {
    const { c, declared, head, token } = await declaredWithWorkspace();
    const lease = declared.change.lease.id;
    const hold = c.writer.holdNext();

    const pending = commitRest(c, token, lease, "commit-key-0007", request(head));
    // Waited out on the test's own timer: `held` settles inside the Change DO's request, and
    // a test awaiting it would go on there, where the test's own stub cannot be used.
    await vi.waitFor(() => expect(c.writer.committed).toHaveLength(1), { timeout: 20_000 });
    ok(
      decodeExit(
        ChangeCodecs.abandon,
        await c.stub.abandon({
          authority: { _tag: "Lease", leaseId: lease, agentId: c.agentId },
          idempotencyKey: "abandon-1",
        }),
      ),
    );
    hold.release();
    const response = await pending;

    expect([response.status, (await response.json<{ code: string }>()).code]).toEqual([
      409,
      "change.state_refused",
    ]);
    expect((await c.current()).state).toBe("withdrawn");
  });
});
