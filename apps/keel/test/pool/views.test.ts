import { env } from "cloudflare:workers";
import { type EventEnvelope, EventEnvelope as Envelope, makeId } from "@keeltown/core/kernel";
import { projectEvents } from "@keeltown/testing";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { BASE, seedAgent, tokenFor, worker } from "./helpers.ts";

/** The one Projector every object's outbox delivers to. */
const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));

/** Events arrive as an outbox delivers them, in one batch. */
const arrive = async (...events: EventEnvelope[]) => {
  await projector().receive(events.map((event) => Schema.encodeSync(Envelope)(event)));
};

const get = (token: string, path: string) =>
  worker(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });

interface ListBody {
  readonly items: readonly { readonly changeId: string; readonly number: number }[];
}
interface ProblemBody {
  readonly code: string;
  readonly detail?: string;
}
interface SnapshotBody {
  readonly cursor: string;
  readonly changes: readonly { readonly changeId: string; readonly state: string }[];
  readonly trunk?: { readonly head: string; readonly height: number };
}
interface EventsBody {
  readonly items: readonly { readonly eventId: string; readonly project?: string }[];
}

describe("Mission Control's views through the doorway", () => {
  it("[b12.change-list-scope] lets an agent read its own project's changes, and answers 403 for any other project, existing or not", async () => {
    const mine = projectEvents();
    const theirs = projectEvents();
    const [own, foreign] = [makeId("chg", ulid()), makeId("chg", ulid())];
    const agentId = makeId("agt", ulid());
    await arrive(
      mine.declared(own, agentId, "Cache sessions"),
      theirs.declared(foreign, agentId, "Another project's change"),
    );
    const agent = await tokenFor(await seedAgent({ projectId: mine.project }));

    const listed = await get(agent, "/v1/changes");
    const named = await get(agent, `/v1/changes?project=${mine.project}`);
    const other = await get(agent, `/v1/changes?project=${theirs.project}`);
    const missing = await get(agent, `/v1/changes?project=${makeId("prj", ulid())}`);
    const otherSnapshot = await get(agent, `/v1/events/snapshot?project=${theirs.project}`);

    expect([listed.status, named.status]).toEqual([200, 200]);
    expect((await listed.json<ListBody>()).items).toMatchObject([{ changeId: own, number: 1 }]);
    expect((await named.json<ListBody>()).items).toMatchObject([{ changeId: own, number: 1 }]);
    expect([other.status, missing.status, otherSnapshot.status]).toEqual([403, 403, 403]);
    const [otherBody, missingBody] = [
      await other.json<ProblemBody>(),
      await missing.json<ProblemBody>(),
    ];
    // An existing project and a missing one are refused alike, so nothing about either leaks.
    expect([otherBody.code, otherBody.detail]).toEqual([missingBody.code, missingBody.detail]);
  });

  it("[b12.change-list-scope] lets an observer read any project's changes and snapshot", async () => {
    const theirs = projectEvents();
    const change = makeId("chg", ulid());
    await arrive(theirs.declared(change, makeId("agt", ulid()), "Revoke tokens"));
    const observer = await tokenFor(await seedAgent({}, ["observer"]));

    const listed = await get(observer, `/v1/changes?project=${theirs.project}`);
    const snapshot = await get(observer, `/v1/events/snapshot?project=${theirs.project}`);

    expect([listed.status, snapshot.status]).toEqual([200, 200]);
    expect((await listed.json<ListBody>()).items).toMatchObject([{ changeId: change }]);
    expect((await snapshot.json<SnapshotBody>()).changes).toMatchObject([{ changeId: change }]);
  });

  it("[b12.snapshot] answers the head's state and cursor, and the events after that cursor are exactly what it does not hold", async () => {
    const events = projectEvents();
    const change = makeId("chg", ulid());
    await arrive(
      events.declared(change, makeId("agt", ulid()), "Cache sessions"),
      events.trunkInitialized("c".repeat(40)),
    );
    const observer = await tokenFor(await seedAgent({}, ["observer"]));

    const response = await get(observer, `/v1/events/snapshot?project=${events.project}`);
    const snapshot = await response.json<SnapshotBody>();
    const later = events.started(change);
    await arrive(later);
    const forward = await get(observer, `/v1/events?cursor=${snapshot.cursor}&limit=500`);
    const folded = (await forward.json<EventsBody>()).items.filter(
      (event) => event.project === events.project,
    );

    expect(response.status).toBe(200);
    expect(snapshot.changes).toMatchObject([{ changeId: change, state: "declared" }]);
    expect(snapshot.trunk).toEqual({ head: "c".repeat(40), height: 0 });
    expect(folded.map((event) => event.eventId)).toEqual([later.eventId]);
  });
});
