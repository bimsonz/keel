// A project's issues through the real Worker: its own object holds them, the
// Projector numbers them from the sequence its changes share, the policy
// decides who opens, comments, closes and reopens, and a landed change closes
// the issues its goal names.
import { env, exports } from "cloudflare:workers";
import {
  EventEnvelope,
  makeId,
  type NamespaceId,
  type ProjectId,
  type UserId,
} from "@keeltown/core/kernel";
import { PORTS } from "@keeltown/testing";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { IssueNumbersRpc } from "../../src/adapters/driven/do-rpc/issue-numbers.ts";
import { IssuesRpc } from "../../src/adapters/driven/do-rpc/issues.ts";
import { changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainOutbox,
  establishProject,
  mcp,
  mcpResult,
  placeProject,
  seedForeignAgent,
  seedOrg,
  seedUser,
  tokenFor,
  uniqueHandle,
} from "./helpers.ts";

const projectStub = (projectId: ProjectId) =>
  env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`));
const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

PORTS.Issues.contract("do-rpc", () => IssuesRpc(projectStub));
PORTS.IssueNumbers.contract("do-rpc", () => IssueNumbersRpc(projector));

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  bearer: string | null,
  method: string,
  path: string,
  body?: object,
): Promise<Answer> {
  const response = await exports.default.fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      "cf-connecting-ip": `2001:db8::${crypto.randomUUID().slice(0, 4)}`,
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...(method === "GET" ? {} : { "idempotency-key": `issue-${crypto.randomUUID()}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
}

/** An org with its owner, a project placed in it and made public (or left private). */
async function aProject(visibility: "public" | "private" = "public") {
  const org: NamespaceId = makeId("org", ulid());
  const owner: UserId = makeId("usr", ulid());
  await seedOrg(org, uniqueHandle("iss"), owner, uniqueHandle("owner"));
  const maintainer = await seedUser(uniqueHandle("mia"), { org, role: "maintainer" });
  const projectId: ProjectId = makeId("prj", ulid());
  await placeProject(projectId, org);
  await establishProject(projectId);
  if (visibility === "public") {
    const settings = await call(maintainer.token, "PUT", `/projects/${projectId}/settings`, {
      protectedPaths: [],
      maxBatchSize: 8,
      verification: "required",
      visibility: "public",
    });
    if (settings.status !== 200)
      throw new Error(`making the project public answered ${settings.status}`);
  }
  return { org, projectId, maintainer };
}

/** A signed-in person of no org at all. */
const stranger = () => seedUser(uniqueHandle("sam"), { role: null });

/** An agent of another org that nobody sponsors. */
async function unsponsored() {
  const seeded = await seedForeignAgent();
  await env.DB.prepare(`UPDATE agents SET sponsor_user = NULL WHERE id = ?`)
    .bind(seeded.agent.id)
    .run();
  return tokenFor(seeded);
}

describe("[issues.http] a project's issues, through the real Worker", () => {
  it("[issues.http] anyone signed in opens and comments on a public project's issues, an agent only when a person sponsors it, and everyone reads them", async () => {
    const { projectId } = await aProject();
    const sam = await stranger();
    const opened = await call(sam.token, "POST", `/projects/${projectId}/issues`, {
      title: "Sign-in loops on Safari",
      body: "Steps to see it…",
    });
    expect(opened).toMatchObject({
      status: 201,
      body: {
        number: 1,
        state: "open",
        author: `user:${sam.userId}`,
        authorHandle: sam.handle,
        comments: 0,
      },
    });

    const sponsored = await tokenFor(await seedForeignAgent());
    const commented = await call(sponsored, "POST", `/projects/${projectId}/issues/1/comments`, {
      body: "Seen it too",
    });
    expect(commented.status).toBe(201);
    const refused = await call(await unsponsored(), "POST", `/projects/${projectId}/issues`, {
      title: "Spam",
    });
    expect(refused).toMatchObject({ status: 403, body: { code: "auth.forbidden" } });
    expect(refused.body["nextActions"]).toMatchObject([{ operationId: "askSponsor" }]);
    expect(
      (await call(null, "POST", `/projects/${projectId}/issues`, { title: "Anon" })).status,
    ).toBe(401);

    const listed = await call(null, "GET", `/projects/${projectId}/issues`);
    expect(listed).toMatchObject({ status: 200, body: { open: 1, closed: 0 } });
    expect(listed.body["items"]).toMatchObject([{ number: 1, comments: 1 }]);
    const thread = await call(null, "GET", `/projects/${projectId}/issues/1`);
    expect(thread.body["comments"]).toMatchObject([{ body: "Seen it too" }]);
    expect((await call(null, "GET", `/projects/${projectId}/issues/9`)).body).toMatchObject({
      code: "issue.not_found",
    });

    // The MCP tool answers what REST does.
    const viaMcp = await mcpResult(
      await mcp(
        sponsored,
        "tools/call",
        { name: "issue", arguments: { projectId, number: 1 } },
        "issue",
      ),
    );
    const viaRest = await call(sponsored, "GET", `/projects/${projectId}/issues/1`);
    expect(viaMcp["structuredContent"]).toEqual(viaRest.body);
  });

  it("[issues.http] its author or the project's maintainer closes and reopens an issue, and nobody else", async () => {
    const { projectId, maintainer } = await aProject();
    const [sam, other] = [await stranger(), await stranger()];
    await call(sam.token, "POST", `/projects/${projectId}/issues`, { title: "A request" });
    const path = `/projects/${projectId}/issues/1`;

    expect((await call(other.token, "POST", `${path}/close`, {})).status).toBe(403);
    expect(await call(sam.token, "POST", `${path}/close`, { reason: "not-planned" })).toMatchObject(
      { status: 200, body: { state: "closed", closedReason: "not-planned" } },
    );
    expect((await call(other.token, "POST", `${path}/reopen`)).status).toBe(403);
    expect(await call(maintainer.token, "POST", `${path}/reopen`)).toMatchObject({
      status: 200,
      body: { state: "open" },
    });
    expect((await call(maintainer.token, "POST", `${path}/close`, {})).body).toMatchObject({
      state: "closed",
      closedReason: "completed",
      closedBy: `user:${maintainer.userId}`,
    });
  });

  it("[issues.http] a private project's issues are there for its members alone", async () => {
    const { projectId, maintainer } = await aProject("private");
    const sam = await stranger();
    expect(
      (await call(sam.token, "POST", `/projects/${projectId}/issues`, { title: "x" })).status,
    ).toBe(404);
    expect((await call(null, "GET", `/projects/${projectId}/issues`)).status).toBe(404);
    expect(
      (await call(maintainer.token, "POST", `/projects/${projectId}/issues`, { title: "Ours" }))
        .status,
    ).toBe(201);
  });
});

describe("[issues.numbers] issues and changes share a project's #n", () => {
  it("[issues.numbers] an issue takes the number after the project's last change, and the change after it the next", async () => {
    const { projectId } = await aProject();
    const before = await changeUnderTest(projectId, "project", false);
    ok(await before.declare("declare-before"));
    await drainOutbox(before.stub);
    const sam = await stranger();
    const opened = await call(sam.token, "POST", `/projects/${projectId}/issues`, {
      title: "Between",
    });
    expect(opened.body["number"]).toBe(2);
    // The feed labels the issue's opening with that same #n.
    await drainOutbox(projectStub(projectId));
    const feed = await call(null, "GET", `/events?project=${projectId}`);
    const items: readonly { type: string; label?: string }[] = Array.isArray(feed.body["items"])
      ? feed.body["items"]
      : [];
    expect(items.filter((e) => e.type === "IssueOpened").map((e) => e.label)).toEqual(["#2"]);
    const after = await changeUnderTest(projectId, "project", false);
    ok(await after.declare("declare-after"));
    await drainOutbox(after.stub);
    const changes = await call(null, "GET", `/changes?project=${projectId}`);
    const numbers = Object.fromEntries(
      (Array.isArray(changes.body["items"]) ? changes.body["items"] : []).map(
        (c: { changeId: string; number: number }) => [c.changeId, c.number],
      ),
    );
    expect(numbers).toEqual({ [before.changeId]: 1, [after.changeId]: 3 });
  });
});

describe("[issues.fixes] a landed change closes the issues its goal names", () => {
  it("[issues.fixes] Fixes #n in a change's goal closes issue #n as completed when the change lands, and a number it has no issue of closes nothing", async () => {
    const { projectId } = await aProject();
    const sam = await stranger();
    await call(sam.token, "POST", `/projects/${projectId}/issues`, { title: "Fix me" });
    await call(sam.token, "POST", `/projects/${projectId}/issues`, { title: "Leave me" });
    const fix = await changeUnderTest(projectId, "project", false);
    ok(await fix.declare("declare-fix", { goal: "Stop the sign-in loop. Fixes #1, closes #99" }));
    await drainOutbox(fix.stub);
    await drainOutbox(projectStub(projectId));

    // The landing, as its Change DO commits it, fed to the project as the fan-out feeds it.
    const last = (await fix.log()).at(-1);
    if (last === undefined) throw new Error("the change committed nothing");
    const landed: EventEnvelope = {
      ...last,
      eventId: makeId("evt", ulid()),
      type: "ChangeLanded",
      seq: last.seq + 1,
      dedupeKey: `landed-${fix.changeId}`,
      payload: { _tag: "ChangeLanded", changeId: fix.changeId },
    };
    await projectStub(projectId).receive([Schema.encodeSync(EventEnvelope)(landed)]);
    await drainOutbox(projectStub(projectId));

    expect(
      (await call(null, "GET", `/projects/${projectId}/issues/1`)).body["issue"],
    ).toMatchObject({
      state: "closed",
      closedReason: "completed",
      closedByChange: fix.changeId,
    });
    expect(
      (await call(null, "GET", `/projects/${projectId}/issues/2`)).body["issue"],
    ).toMatchObject({
      state: "open",
    });
  });
});
