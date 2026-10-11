// A public project's live activity read without a token, through the deployed
// fetch handler: the project is a real Project DO (on in-memory code, trunk
// and pool), made public by an operator through the settings route, and its
// changes' events reach the real Projector as an outbox delivers them.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type EventEnvelope, EventEnvelope as Envelope, makeId } from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  projectEvents,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { backbone } from "../../src/composition/do.ts";
import { ok } from "./change-harness.ts";
import { BASE, drainAfter, drainOutbox, seedAgent, tokenFor, worker } from "./helpers.ts";
import { decodeExit, ProjectCodecs } from "../../src/rpc/index.ts";

const SOURCE = { namespace: "keel-core", name: "seed-app" };

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

/** A created project, private as created; `open()` has an operator make it public through the settings route. */
async function project() {
  const projectId = makeId("prj", ulid());
  const stub = drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));
  const code = makeCodeHostMemory();
  await runInDurableObject(stub, (instance: ProjectDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(
          backbone(state.storage),
          code.layer,
          makeTrunksMemory().layer,
          makeWorkspacePoolMemory().layer,
        ),
      ),
    );
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(SOURCE);
      yield* (yield* CodeHostFixture).commit(SOURCE, "refs/heads/main", { "a.txt": "a" });
    }).pipe(Effect.provide(code.layer)),
  );
  ok(
    decodeExit(
      ProjectCodecs.createProject,
      await stub.createProject({
        projectId,
        name: "Seed app",
        source: SOURCE.name,
        by: makeId("agt", ulid()),
        idempotencyKey: "create-1",
        fingerprint: "body-1",
      }),
    ),
  );
  await drainOutbox(stub);
  const open = async () => {
    const operator = await tokenFor(await seedAgent({}, ["operator"]));
    const put = await worker(`${BASE}/v1/projects/${projectId}/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ protectedPaths: [], maxBatchSize: 1, visibility: "public" }),
    });
    expect(put.status).toBe(200);
    await drainOutbox(stub);
  };
  return { projectId, events: projectEvents(projectId), open };
}

/** The feed's head as an observer reads it: what any later read starts from. */
const head = async (observer: string) =>
  (await (await get("/v1/events/snapshot", observer)).json<{ cursor: string }>()).cursor;

describe("[b12.public-feed] a public project's live activity without a token", () => {
  it("[b12.public-feed] serves the project's public events only: no other project's, and no members-only settings change, which its observer does read", async () => {
    const observer = await tokenFor(await seedAgent({}, ["observer"]));
    const p = await project();
    const other = projectEvents();
    const cursor = await head(observer);
    await p.open();
    const change = makeId("chg", ulid());
    await arrive(
      p.events.declared(change, makeId("agt", ulid()), "Cache sessions"),
      other.declared(makeId("chg", ulid()), makeId("agt", ulid()), "Another project's change"),
      p.events.started(change),
    );

    const anonymous = await get(`/v1/events?project=${p.projectId}&cursor=${cursor}&limit=500`);
    const member = await get(
      `/v1/events?project=${p.projectId}&cursor=${cursor}&limit=500`,
      observer,
    );

    expect(anonymous.status).toBe(200);
    expect(await types(anonymous)).toEqual(["IntentDeclared", "ChangeStarted"]);
    expect(member.status).toBe(200);
    expect(await types(member)).toEqual([
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
  it("[b12.public-refused] answers 401 to a read without a token that names no project, never reading every project", async () => {
    const answers = await Promise.all(
      ["/v1/events", "/v1/changes", "/v1/events/snapshot"].map((path) => get(path)),
    );
    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401]);
    for (const answer of answers)
      expect((await answer.json<ProblemBody>()).code).toBe("auth.invalid_token");
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

  it("[b12.public-refused] lets an agent of another project read a public project's public events, and refuses it a private one", async () => {
    const observer = await tokenFor(await seedAgent({}, ["observer"]));
    const agent = await tokenFor(await seedAgent());
    const open = await project();
    const closed = await project();
    const cursor = await head(observer);
    await open.open();
    await arrive(open.events.declared(makeId("chg", ulid()), makeId("agt", ulid()), "Cache"));

    const read = await get(
      `/v1/events?project=${open.projectId}&cursor=${cursor}&limit=500`,
      agent,
    );
    const listed = await get(`/v1/changes?project=${open.projectId}`, agent);
    const refused = await get(`/v1/events?project=${closed.projectId}`, agent);

    expect(read.status).toBe(200);
    expect(await types(read)).toEqual(["IntentDeclared"]);
    expect(listed.status).toBe(200);
    expect(refused.status).toBe(403);
  });
});
