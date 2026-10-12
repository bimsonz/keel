import { env } from "cloudflare:workers";
import { EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { BASE, seedAgent, seedUser, tokenFor, uniqueHandle, worker } from "./helpers.ts";
import { project as heldProject } from "./project-harness.ts";

/** The one Projector every object's outbox delivers to. */
const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

interface Page {
  readonly items: readonly {
    readonly eventId: string;
    readonly type: string;
    readonly project?: string;
    readonly label?: string;
    readonly at: string;
    readonly payload: { readonly _tag: string };
  }[];
  readonly nextCursor: string;
}

async function events(token: string, query = "") {
  const response = await worker(`${BASE}/v1/events${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json<Page & { code: string }>() };
}

/** A change starting in `project`, delivered to the Projector as the Change DO's outbox would. */
async function arrive(
  project: ProjectId,
  type: "IntentDeclared" | "ChangeStarted" = "ChangeStarted",
) {
  const changeId = makeId("chg", ulid());
  const payload =
    type === "ChangeStarted"
      ? { _tag: "ChangeStarted", changeId, workspaceId: makeId("wsp", ulid()) }
      : {
          _tag: "IntentDeclared",
          changeId,
          agentId: makeId("agt", ulid()),
          origin: "agent",
          revision: 1,
          goal: "Cache permission lookups per request",
          footprint: [],
          premises: [],
          leaseId: makeId("lse", ulid()),
        };
  const event = Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulid()),
    type,
    entity: { kind: "change", id: changeId },
    seq: 1,
    at: Date.UTC(2026, 9, 11, 9),
    dedupeKey: `change:${changeId}/events-test/${type}#1`,
    project,
    affected: [],
    notified: [],
    payload,
  });
  await projector().receive([Schema.encodeSync(EventEnvelope)(event)]);
  return event;
}

/** The feed's end as `token` sees it: read on until a page comes back empty. */
async function head(token: string) {
  let page = await events(token, "?limit=500");
  while (page.body.items.length > 0)
    page = await events(token, `?limit=500&cursor=${page.body.nextCursor}`);
  return page.body.nextCursor;
}

/** Two private projects of org `pool`, each held by its real Project DO, and a member of the org who reads both. */
async function tenancy() {
  const [a, b] = [await heldProject(), await heldProject()];
  const member = (await seedUser(uniqueHandle("member"))).token;
  return { projectA: a.projectId, projectB: b.projectId, member };
}

describe("GET /v1/events", () => {
  it("[a11.events] serves the feed as EventRecords, with a cursor on every page", async () => {
    const { projectA, member } = await tenancy();
    const from = await head(member);
    const declared = await arrive(projectA, "IntentDeclared");
    const started = await arrive(projectA);
    const page = await events(member, `?cursor=${from}`);
    expect(page.status).toBe(200);
    expect(page.body.items.map((e) => e.eventId)).toEqual([declared.eventId, started.eventId]);
    expect(page.body.items[0]).toMatchObject({
      type: "IntentDeclared",
      project: projectA,
      label: "#1",
      at: "2026-10-11T09:00:00.000Z",
      payload: { _tag: "IntentDeclared" },
    });
    expect(page.body.nextCursor > from).toBe(true);
    // D8: the last page still answers its cursor, the one it was read from.
    const after = await events(member, `?cursor=${page.body.nextCursor}`);
    expect(after.body).toEqual({ items: [], nextCursor: page.body.nextCursor });
  });

  it("[a11.events-wait] answers a waiting read as soon as an event arrives", async () => {
    const { projectA, member } = await tenancy();
    const from = await head(member);
    const started = Date.now();
    const waiting = events(member, `?cursor=${from}&wait=20`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const arrived = await arrive(projectA);
    const page = await waiting;
    expect(page.body.items.map((e) => e.eventId)).toContain(arrived.eventId);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("[a11.events-scope] shows an agent its own project only, and a member of the org every project it may read", async () => {
    const { projectA, projectB, member } = await tenancy();
    const agent = await tokenFor(await seedAgent({ projectId: projectA }, ["agent:read"]));
    const agentFrom = await head(agent);
    const memberFrom = await head(member);
    const mine = await arrive(projectA);
    const theirs = await arrive(projectB);
    const seenByAgent = await events(agent, `?cursor=${agentFrom}`);
    expect(seenByAgent.body.items.map((e) => e.eventId)).toEqual([mine.eventId]);
    // The agent's cursor still moves past the event it may not see.
    expect(seenByAgent.body.nextCursor).toBe(
      (await events(member, `?cursor=${memberFrom}`)).body.nextCursor,
    );
    const seenByMember = await events(member, `?cursor=${memberFrom}`);
    expect(seenByMember.body.items.map((e) => e.eventId)).toEqual([mine.eventId, theirs.eventId]);
    // A project with no place in any org is no one's to read: its events reach no reader.
    const unplaced = await arrive(makeId("prj", ulid()));
    const after = await events(member, `?cursor=${seenByMember.body.nextCursor}`);
    expect(after.body.items.map((e) => e.eventId)).not.toContain(unplaced.eventId);
  });

  it("[a11.events-cursor] refuses a cursor that is not a feed position, naming it", async () => {
    const { member } = await tenancy();
    const page = await events(member, "?cursor=not-a-cursor");
    expect(page.status).toBe(400);
    expect(JSON.stringify(page.body)).toMatch(/cursor/);
  });

  it("[a11.events-anonymous] answers a caller without a token that names no project 400: only a signed-in user reads across projects", async () => {
    const response = await worker(`${BASE}/v1/events`);
    const body = await response.json<{ code: string; issues: { path: string[] }[] }>();
    expect([response.status, body.code]).toEqual([400, "request.invalid"]);
    expect(body.issues.map((issue) => issue.path)).toEqual([["project"]]);
  });
});
