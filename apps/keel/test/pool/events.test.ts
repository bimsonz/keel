import { runInDurableObject } from "cloudflare:test";
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

/** `count` changes starting in `project`, delivered to the Projector a couple of hundred at a time. */
async function flood(project: ProjectId, count: number) {
  const encode = Schema.encodeSync(EventEnvelope);
  for (let sent = 0; sent < count; sent += 200) {
    const batch = Array.from({ length: Math.min(200, count - sent) }, () => {
      const changeId = makeId("chg", ulid());
      return encode(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: makeId("evt", ulid()),
          type: "ChangeStarted",
          entity: { kind: "change", id: changeId },
          seq: 1,
          at: Date.UTC(2026, 9, 11, 9),
          dedupeKey: `change:${changeId}/events-test/ChangeStarted#1`,
          project,
          affected: [],
          notified: [],
          payload: { _tag: "ChangeStarted", changeId, workspaceId: makeId("wsp", ulid()) },
        }),
      );
    });
    await projector().receive(batch);
  }
}

/**
 * The feed's end as `token` sees it: read on until a page comes back empty. A
 * page of events that ends no later than the cursor it was read from is a feed
 * that did not read from it, and would never come back empty.
 */
async function head(token: string) {
  let page = await events(token, "?limit=500");
  while (page.body.items.length > 0) {
    const from = page.body.nextCursor;
    page = await events(token, `?limit=500&cursor=${from}`);
    if (page.body.items.length > 0 && page.body.nextCursor <= from)
      throw new Error(
        `the feed read from ${from} answered events and ends at ${page.body.nextCursor}`,
      );
  }
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

  it("[feed.reason-as-written] serves a verdict's evidence and its bounce's reasons as written: `<`, `>` and `&` are never escaped", async () => {
    const { projectA, member } = await tenancy();
    const from = await head(member);
    const changeId = makeId("chg", ulid());
    const verdictId = makeId("vrd", ulid());
    const line = `guard failed: guard:${makeId("grd", ulid())} (freshness): subject DELETE /repos/owner/repo?a=1&b=2 -> 204 (expected <403>)`;
    const envelope = (type: string, entity: { kind: string; id: string }, payload: object) =>
      Schema.encodeSync(EventEnvelope)(
        Schema.decodeUnknownSync(EventEnvelope)({
          eventId: makeId("evt", ulid()),
          type,
          entity,
          seq: 1,
          at: Date.UTC(2026, 9, 14, 3),
          dedupeKey: `${entity.kind}:${entity.id}/events-test/${type}#1`,
          project: projectA,
          affected: [],
          notified: [],
          payload: { _tag: type, ...payload },
        }),
      );
    await projector().receive([
      envelope(
        "VerdictIssued",
        { kind: "verdict", id: verdictId },
        { verdictId, subject: changeId, outcome: "bounce", evidence: [line] },
      ),
      envelope(
        "ChangeBounced",
        { kind: "change", id: changeId },
        { changeId, verdictId, reasons: [line] },
      ),
    ]);
    const page = await events(member, `?cursor=${from}`);
    expect(page.status).toBe(200);
    expect(page.body.items.map((e) => e.payload)).toEqual([
      expect.objectContaining({ _tag: "VerdictIssued", evidence: [line] }),
      expect.objectContaining({ _tag: "ChangeBounced", reasons: [line] }),
    ]);
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

  it("[t3.feed-project-wait] an agent's waiting read is answered by its own project's next event, and is not woken by another project's", async () => {
    const { projectA, projectB } = await tenancy();
    const agent = await tokenFor(await seedAgent({ projectId: projectA }, ["agent:read"]));
    const from = await head(agent);
    const started = Date.now();
    const waiting = events(agent, `?cursor=${from}&wait=20`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await arrive(projectB);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const mine = await arrive(projectA);
    const page = await waiting;
    // Its own event, and so only after that arrived: the other project's did not answer it.
    expect(page.body.items.map((e) => e.eventId)).toEqual([mine.eventId]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("[t3.feed-project-pages] a project's events behind hundreds of another's come in one page, whose cursor is past them all", async () => {
    const { projectA, projectB, member } = await tenancy();
    const agent = await tokenFor(await seedAgent({ projectId: projectA }, ["agent:read"]));
    const from = await head(agent);
    const first = await arrive(projectA);
    await flood(projectB, 600);
    const [second, third] = [await arrive(projectA), await arrive(projectA)];

    // One request of a hundred: a walk of the whole feed would have reached only the first.
    const page = await events(agent, `?cursor=${from}&limit=100`);
    expect(page.body.items.map((e) => e.eventId)).toEqual([
      first.eventId,
      second.eventId,
      third.eventId,
    ]);
    const after = await events(agent, `?cursor=${page.body.nextCursor}`);
    expect(after.body).toEqual({ items: [], nextCursor: page.body.nextCursor });
    // The cursor is past every one of the other project's events: a member reading on from it finds none.
    const beyond = await events(member, `?cursor=${page.body.nextCursor}&limit=500`);
    expect(beyond.body.items).toEqual([]);
  });

  it("[feed.end-waits] `cursor=end` answers no events and the head, and with a wait the next event to arrive and nothing from before, for a member and for an agent's own project", async () => {
    const { projectA, projectB, member } = await tenancy();
    const agent = await tokenFor(await seedAgent({ projectId: projectA }, ["agent:read"]));
    const before = await arrive(projectA);
    const at = await head(member);
    const end = await events(member, "?cursor=end");
    expect([end.status, end.body.items, end.body.nextCursor]).toEqual([200, [], at]);
    const mine = await events(agent, "?cursor=end");
    expect([mine.status, mine.body.items, mine.body.nextCursor]).toEqual([200, [], at]);

    const started = Date.now();
    const waiting = events(member, "?cursor=end&wait=8");
    const waitingMine = events(agent, "?cursor=end&wait=8");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await arrive(projectB);
    const arrived = await arrive(projectA);
    const page = await waiting;
    expect(page.body.items.map((e) => e.eventId)).not.toContain(before.eventId);
    expect(page.body.items.length).toBeGreaterThan(0);
    // The agent's read is answered by its own project's arrival alone.
    expect((await waitingMine).body.items.map((e) => e.eventId)).toEqual([arrived.eventId]);
    expect(Date.now() - started).toBeLessThan(6_000);
    // Reading on from the cursor `end` gave: both arrivals, and nothing from before it.
    const on = await events(member, `?cursor=${end.body.nextCursor}`);
    expect(on.body.items.map((e) => e.eventId)).toContain(arrived.eventId);
    expect(on.body.items.map((e) => e.eventId)).not.toContain(before.eventId);
  });

  it("[feed.restart-under-wait] a waiting read whose Projector restarts under it is held on, never a 500: what arrives next answers it well before its deadline, and nothing is missed", async () => {
    const { projectA, member } = await tenancy();
    const from = await head(member);
    const started = Date.now();
    const waiting = events(member, `?project=${projectA}&cursor=${from}&limit=500&wait=20`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // What a deploy does to the object: it restarts with the read held inside it.
    await runInDurableObject(projector(), (_instance, state) =>
      state.abort("the Projector restarts under a held read"),
    ).catch(() => undefined);
    // The read was read again as the object stood, and the wait holds on from there.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const arrived = await arrive(projectA);
    const page = await waiting;
    expect([page.status, page.body.items.map((e) => e.eventId)]).toEqual([200, [arrived.eventId]]);
    // Answered by the arrival, not at the wait's end.
    expect(Date.now() - started).toBeLessThan(10_000);
    const on = await events(member, `?project=${projectA}&cursor=${page.body.nextCursor}`);
    expect(on.body.items).toEqual([]);
  });

  it("[feed.timeout-beside-wait] a waiting read that times out answers its own empty page and leaves a younger one waiting: both are answered 200, each at its own deadline", async () => {
    const { projectA, member } = await tenancy();
    const from = await head(member);
    const timed = async (wait: number) => {
      const started = Date.now();
      const page = await events(
        member,
        `?project=${projectA}&cursor=${from}&limit=500&wait=${wait}`,
      );
      return { page, ms: Date.now() - started };
    };
    const older = timed(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const younger = timed(2);
    const [first, second] = await Promise.all([older, younger]);
    expect([first.page.status, first.page.body.items]).toEqual([200, []]);
    expect([second.page.status, second.page.body.items]).toEqual([200, []]);
    // The older one's answer woke the younger, which read again and waited on: its page came at its own deadline.
    expect(first.ms).toBeGreaterThanOrEqual(1_000);
    expect(second.ms).toBeGreaterThanOrEqual(2_000);
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
