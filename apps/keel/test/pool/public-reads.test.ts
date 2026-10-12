// A public project's live activity read without a token, through the deployed
// fetch handler: the project is a real Project DO (on in-memory code, trunk
// and pool), placed in org `pool` and made public by a maintainer through the
// settings route, and its changes' events reach the real Projector as an
// outbox delivers them.
import { env } from "cloudflare:workers";
import { type EventEnvelope, EventEnvelope as Envelope, makeId } from "@keeltown/core/kernel";
import { projectEvents } from "@keeltown/testing";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  BASE,
  seedAgent,
  seedForeignAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { project } from "./project-harness.ts";

interface EventsBody {
  readonly items: readonly { readonly type: string; readonly project?: string }[];
  readonly nextCursor: string;
}
interface ProblemBody {
  readonly code: string;
  readonly detail?: string;
}

/** Events arrive as an outbox delivers them, in one batch. */
const arrive = async (...events: EventEnvelope[]) => {
  const projector = env.PROJECTOR.get(env.PROJECTOR.idFromName("projector"));
  await projector.receive(events.map((event) => Schema.encodeSync(Envelope)(event)));
};

/** A GET through the doorway, with a bearer token or with none. */
const get = (path: string, token?: string) =>
  worker(
    `${BASE}${path}`,
    token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
  );

const types = async (response: Response) =>
  (await response.json<EventsBody>()).items.map((event) => event.type);

/** The feed's head as a member of the project's org reads it: what any later read starts from. */
const head = async (member: string, projectId: string) =>
  (
    await (
      await get(`/v1/events/snapshot?project=${projectId}`, member)
    ).json<{
      cursor: string;
    }>()
  ).cursor;

/** A member of org `pool`, which every project here is placed in. */
const member = async () => (await seedUser(uniqueHandle("member"))).token;

describe("[b12.public-feed] a public project's live activity without a token", () => {
  it("[b12.public-feed] serves the project's public events only: no other project's, and no members-only settings change, which a member of its org does read", async () => {
    const reader = await member();
    const p = await project();
    const other = projectEvents();
    const cursor = await head(reader, p.projectId);
    await p.open();
    const change = makeId("chg", ulid());
    await arrive(
      p.events.declared(change, makeId("agt", ulid()), "Cache sessions"),
      other.declared(makeId("chg", ulid()), makeId("agt", ulid()), "Another project's change"),
      p.events.started(change),
    );

    const anonymous = await get(`/v1/events?project=${p.projectId}&cursor=${cursor}&limit=500`);
    const members = await get(
      `/v1/events?project=${p.projectId}&cursor=${cursor}&limit=500`,
      reader,
    );

    expect(anonymous.status).toBe(200);
    expect(await types(anonymous)).toEqual(["IntentDeclared", "ChangeStarted"]);
    expect(members.status).toBe(200);
    expect(await types(members)).toEqual([
      "ProjectSettingsChanged",
      "IntentDeclared",
      "ChangeStarted",
    ]);
  });
});

describe("[b12.public-views] a public project's changes and snapshot without a token", () => {
  it("[b12.public-views] answers the change list and the snapshot", async () => {
    const p = await project();
    await p.open();
    const change = makeId("chg", ulid());
    await arrive(p.events.declared(change, makeId("agt", ulid()), "Cache sessions"));

    const listed = await get(`/v1/changes?project=${p.projectId}`);
    const snapshot = await get(`/v1/events/snapshot?project=${p.projectId}`);

    expect([listed.status, snapshot.status]).toEqual([200, 200]);
    expect((await listed.json<{ items: unknown[] }>()).items).toMatchObject([{ changeId: change }]);
    expect((await snapshot.json<{ changes: unknown[] }>()).changes).toMatchObject([
      { changeId: change },
    ]);
  });
});

describe("[b12.public-refused] what stays authenticated", () => {
  it("[b12.public-refused] never reads every project to a caller without a token that names none: the feed asks for a project, the change list and snapshot read the caller's own, and it has none", async () => {
    const answers = await Promise.all(
      ["/v1/events", "/v1/changes", "/v1/events/snapshot"].map((path) => get(path)),
    );
    expect(answers.map((answer) => answer.status)).toEqual([400, 404, 404]);
    expect(await Promise.all(answers.map(async (a) => (await a.json<ProblemBody>()).code))).toEqual(
      ["request.invalid", "resource.not_found", "resource.not_found"],
    );
  });

  it("[b12.public-refused] answers a private project and one that does not exist alike, 404, without a token", async () => {
    const p = await project();
    const missing = makeId("prj", ulid());
    for (const path of ["/v1/events", "/v1/changes", "/v1/events/snapshot"]) {
      const closed = await get(`${path}?project=${p.projectId}`);
      const absent = await get(`${path}?project=${missing}`);
      expect([closed.status, absent.status]).toEqual([404, 404]);
      const [closedBody, absentBody] = [
        await closed.json<ProblemBody>(),
        await absent.json<ProblemBody>(),
      ];
      expect(closedBody.code).toBe(absentBody.code);
      expect(closedBody.detail?.replace(p.projectId, "<prj>")).toBe(
        absentBody.detail?.replace(missing, "<prj>"),
      );
    }
  });

  it("[b12.public-refused] refuses a bad token on a public project rather than reading it as anonymous", async () => {
    const p = await project();
    await p.open();
    const answer = await get(`/v1/events?project=${p.projectId}`, "not-a-token");
    expect(answer.status).toBe(401);
  });

  it("[b12.public-refused] lets an agent of another project read a public project's public events, and refuses it a private one: its own org's by name, another org's as missing", async () => {
    const reader = await member();
    const agent = await tokenFor(await seedAgent());
    const foreign = await tokenFor(await seedForeignAgent());
    const open = await project();
    const closed = await project();
    const cursor = await head(reader, open.projectId);
    await open.open();
    await arrive(open.events.declared(makeId("chg", ulid()), makeId("agt", ulid()), "Cache"));

    const read = await get(
      `/v1/events?project=${open.projectId}&cursor=${cursor}&limit=500`,
      agent,
    );
    const listed = await get(`/v1/changes?project=${open.projectId}`, agent);
    const refused = await get(`/v1/events?project=${closed.projectId}`, agent);
    const hidden = await get(`/v1/events?project=${closed.projectId}`, foreign);
    const foreignRead = await get(`/v1/changes?project=${open.projectId}`, foreign);

    expect(read.status).toBe(200);
    expect(await types(read)).toEqual(["IntentDeclared"]);
    expect(listed.status).toBe(200);
    expect(foreignRead.status).toBe(200);
    expect([refused.status, (await refused.json<ProblemBody>()).detail]).toEqual([
      403,
      "Refused: foreign-project.",
    ]);
    expect([hidden.status, (await hidden.json<ProblemBody>()).code]).toEqual([
      404,
      "resource.not_found",
    ]);
  });
});
