import { env } from "cloudflare:workers";
import { EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { BASE, seedAgent, tokenFor, worker } from "./helpers.ts";

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

const projectA = makeId("prj", ulid());
const projectB = makeId("prj", ulid());

describe("GET /v1/events", () => {
  it("[a11.events] serves the feed as EventRecords, with a cursor on every page", async () => {
    const observer = await tokenFor(await seedAgent({ projectId: projectA }, ["observer"]));
    const from = await head(observer);
    const declared = await arrive(projectA, "IntentDeclared");
    const started = await arrive(projectA);
    const page = await events(observer, `?cursor=${from}`);
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
    const after = await events(observer, `?cursor=${page.body.nextCursor}`);
    expect(after.body).toEqual({ items: [], nextCursor: page.body.nextCursor });
  });

  it("[a11.events-wait] answers a waiting read as soon as an event arrives", async () => {
    const observer = await tokenFor(await seedAgent({ projectId: projectA }, ["observer"]));
    const from = await head(observer);
    const started = Date.now();
    const waiting = events(observer, `?cursor=${from}&wait=20`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const arrived = await arrive(projectA);
    const page = await waiting;
    expect(page.body.items.map((e) => e.eventId)).toContain(arrived.eventId);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("[a11.events-scope] shows an agent its own project only, and an observer every project", async () => {
    const agent = await tokenFor(await seedAgent({ projectId: projectA }, ["agent:read"]));
    const observer = await tokenFor(await seedAgent({ projectId: projectA }, ["observer"]));
    const agentFrom = await head(agent);
    const observerFrom = await head(observer);
    const mine = await arrive(projectA);
    const theirs = await arrive(projectB);
    const seenByAgent = await events(agent, `?cursor=${agentFrom}`);
    expect(seenByAgent.body.items.map((e) => e.eventId)).toEqual([mine.eventId]);
    // The agent's cursor still moves past the event it may not see.
    expect(seenByAgent.body.nextCursor).toBe(
      (await events(observer, `?cursor=${observerFrom}`)).body.nextCursor,
    );
    const seenByObserver = await events(observer, `?cursor=${observerFrom}`);
    expect(seenByObserver.body.items.map((e) => e.eventId)).toEqual([mine.eventId, theirs.eventId]);
  });

  it("[a11.events-cursor] refuses a cursor that is not a feed position, naming it", async () => {
    const observer = await tokenFor(await seedAgent({ projectId: projectA }, ["observer"]));
    const page = await events(observer, "?cursor=not-a-cursor");
    expect(page.status).toBe(400);
    expect(JSON.stringify(page.body)).toMatch(/cursor/);
  });
});
