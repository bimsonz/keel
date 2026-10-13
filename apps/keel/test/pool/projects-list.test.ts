// The list of projects as the doorway answers it,
// through the real gate, handlers and D1: one page is read for the caller's
// audience and the policy decides each row. The app runs over a `DB` that
// records every row Keel's own statements answer, because a list that hides a
// private project looks the same whether its row was read or not. Visibility
// reaches the rows from real Project DOs through the settings route, and from
// the real Projector.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  EventEnvelope as Envelope,
  makeId,
  type NamespaceId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { PROJECTOR, ProjectNamespaces } from "@keeltown/core/ports";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectoryD1 } from "../../src/adapters/driven/d1/agent-directory.ts";
import { ProjectNamespacesD1 } from "../../src/adapters/driven/d1/project-namespaces.ts";
import type { ProjectorDO } from "../../src/adapters/driving/do/projector.ts";
import { backbone } from "../../src/composition/do.ts";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import {
  BASE,
  type Fetch,
  OTHER_ORG,
  OTHER_SPONSOR,
  placeProject,
  POOL_ORG,
  POOL_SPONSOR,
  seedAgent,
  seedOrg,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { project } from "./project-harness.ts";
import { recordingDb } from "./recording-db.ts";

interface Page {
  readonly items: readonly { readonly id: string }[];
  readonly nextCursor?: string;
}

/** The app over a `DB` that records what Keel's own statements answer. Better Auth reads the session from the real one. */
function recordingApp() {
  const recording = recordingDb(env.DB);
  const { app } = makeIsolate(env, isolateLayer({ ...env, DB: recording.db }));
  const via: Fetch = async (url, init) => app.fetch(new Request(url, init), env);
  /** Whether any recorded row names `id`, in any column. */
  const returned = (id: string) => JSON.stringify(recording.rows).includes(id);
  return { via, returned };
}

/** Every page of the list, read to its end through `via`, as `token` or as a visitor. */
async function pages(via: Fetch, token?: string, limit = 100): Promise<Page[]> {
  const read: Page[] = [];
  let cursor: string | undefined;
  do {
    const response = await via(
      `${BASE}/v1/projects?limit=${limit}${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const page = await response.json<Page>();
    read.push(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return read;
}

const listed = async (via: Fetch, token?: string) =>
  (await pages(via, token)).flatMap((page) => page.items.map((item) => item.id));

/** A project's row in `namespace`, private as a new row is. */
async function placed(namespace: NamespaceId, id = ulid()) {
  const projectId = makeId("prj", id);
  await placeProject(projectId, namespace);
  return projectId;
}

/** Writes a project's mirrored visibility, as its Project DO does after a settings commit. */
const mirror = (projectId: ProjectId, visibility: "private" | "public", seq: number) =>
  Effect.runPromise(
    ProjectNamespaces.use((places) => places.visibility(projectId, visibility, seq)).pipe(
      Effect.provide(ProjectNamespacesD1(env.DB)),
    ),
  );

/** A settings event that leaves `projectId` with `visibility`, as its Project DO commits one. */
const settingsChanged = (projectId: string, visibility: "private" | "public", seq: number) => {
  const eventId = makeId("evt", ulid());
  return Schema.decodeUnknownSync(Envelope)({
    eventId,
    type: "ProjectSettingsChanged",
    entity: { kind: "project", id: projectId },
    seq,
    at: Date.now(),
    dedupeKey: `project:${projectId}/${eventId}/ProjectSettingsChanged#1`,
    affected: [],
    notified: [],
    project: projectId,
    payload: {
      _tag: "ProjectSettingsChanged",
      projectId,
      changes: [
        {
          field: "visibility",
          from: visibility === "public" ? "private" : "public",
          to: visibility,
        },
      ],
      by: POOL_SPONSOR,
    },
  });
};

const projector = () => env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR));

const pool = () => seedOrg(POOL_ORG, "pool", POOL_SPONSOR, "pool-sponsor");

describe("[projects.list-visitor] a visitor's list of projects", () => {
  it("[projects.list-visitor] names the public project and not the private one, whose row no statement returned", async () => {
    const open = await project();
    await open.open();
    const closed = await project();
    const { via, returned } = recordingApp();
    const ids = await listed(via);
    expect(ids).toContain(open.projectId);
    expect(ids).not.toContain(closed.projectId);
    expect(returned(open.projectId)).toBe(true);
    expect(returned(closed.projectId)).toBe(false);
  });
});

describe("[projects.list-member] a person's list of projects", () => {
  it("[projects.list-member] names their org's private project and their own; a stranger's names neither, and no statement returned either row to them", async () => {
    await pool();
    await seedOrg(OTHER_ORG, "elsewhere", OTHER_SPONSOR, "elsewhere-owner");
    const inside = await seedUser(uniqueHandle("inside"), { role: "member" });
    const stranger = await seedUser(uniqueHandle("stranger"), { org: OTHER_ORG });
    const orgs = await placed(POOL_ORG);
    const own = await placed(inside.userId);
    const theirs = await placed(OTHER_ORG);

    const member = recordingApp();
    const hers = await listed(member.via, inside.token);
    expect(hers).toEqual(expect.arrayContaining([orgs, own]));
    expect(hers).not.toContain(theirs);
    expect(member.returned(theirs)).toBe(false);

    const outside = recordingApp();
    const his = await listed(outside.via, stranger.token);
    expect(his).toContain(theirs);
    expect(his).not.toContain(orgs);
    expect(his).not.toContain(own);
    expect(outside.returned(orgs)).toBe(false);
    expect(outside.returned(own)).toBe(false);
  });
});

describe("[projects.list-agent] an agent's list of projects", () => {
  it("[projects.list-agent] names its token's project and the public ones, and not another private project of its org, whose row no statement returned", async () => {
    const mine = makeId("prj", ulid());
    const seeded = await seedAgent({ projectId: mine });
    const open = await project();
    await open.open();
    const other = await placed(POOL_ORG);
    const { via, returned } = recordingApp();
    const ids = await listed(via, await tokenFor(seeded));
    expect(ids).toEqual(expect.arrayContaining([mine, open.projectId]));
    expect(ids).not.toContain(other);
    expect(returned(other)).toBe(false);
  });
});

describe("the policy decides every row the list read", () => {
  it("[projects.list-policy] a suspended org's public project is listed to nobody, its member included", async () => {
    const org = makeId("org", ulid());
    await seedOrg(org, uniqueHandle("held"), makeId("usr", ulid()), uniqueHandle("held-owner"));
    const member = await seedUser(uniqueHandle("held-member"), { org, role: "member" });
    const projectId = await placed(org);
    await mirror(projectId, "public", 1);
    expect(await listed(worker)).toContain(projectId);
    expect(await listed(worker, member.token)).toContain(projectId);

    await env.DB.prepare("UPDATE organization SET suspended = 1 WHERE id = ?").bind(org).run();
    expect(await listed(worker)).not.toContain(projectId);
    expect(await listed(worker, member.token)).not.toContain(projectId);
  });

  it("[projects.list-pages] a page whose rows the policy refused is short and still names the next, so the list reads on", async () => {
    const org = makeId("org", ulid());
    await seedOrg(org, uniqueHandle("open"), makeId("usr", ulid()), uniqueHandle("open-owner"));
    const held = makeId("org", ulid());
    await seedOrg(held, uniqueHandle("held"), makeId("usr", ulid()), uniqueHandle("held-owner"));
    await env.DB.prepare("UPDATE organization SET suspended = 1 WHERE id = ?").bind(held).run();
    const [first, second, third] = [ulid(), ulid(), ulid()].toSorted();
    const before = await placed(org, first);
    const refused = await placed(held, second);
    const after = await placed(org, third);
    for (const projectId of [before, refused, after]) await mirror(projectId, "public", 1);

    const read = await pages(worker, undefined, 1);
    const ids = read.flatMap((page) => page.items.map((item) => item.id));
    expect(ids).toEqual(expect.arrayContaining([before, after]));
    expect(ids).not.toContain(refused);
    expect(ids.indexOf(before)).toBeLessThan(ids.indexOf(after));
    const between = read.slice(
      read.findIndex((page) => page.items.some((item) => item.id === before)) + 1,
      read.findIndex((page) => page.items.some((item) => item.id === after)),
    );
    expect(between.some((page) => page.items.length === 0 && page.nextCursor === refused)).toBe(
      true,
    );
  });
});

describe("a project's visibility reaches the list", () => {
  it("[projects.list-mirror] a settings PUT to public shows in the next visitor's list and one back to private leaves it, by the Project object's own write", async () => {
    const p = await project();
    const maintainer = await seedUser(uniqueHandle("mirror"), { role: "maintainer" });
    const put = (visibility: "private" | "public") =>
      worker(`${BASE}/v1/projects/${p.projectId}/settings`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${maintainer.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ protectedPaths: [], maxBatchSize: 1, visibility }),
      });
    // The Projector repeats the write when the event reaches it: here its write does nothing, so only the Project object's shows.
    const stub = projector();
    const repairing = await runInDurableObject(stub, (instance: ProjectorDO, state) => {
      const runtime: unknown = Reflect.get(instance, "runtime");
      Reflect.set(
        instance,
        "runtime",
        ManagedRuntime.make(
          Layer.mergeAll(
            backbone(state.storage),
            AgentDirectoryD1(env.DB),
            Layer.succeed(
              ProjectNamespaces,
              ProjectNamespaces.of({
                assign: () => Effect.die("unused"),
                release: () => Effect.die("unused"),
                byId: () => Effect.die("unused"),
                byName: () => Effect.die("unused"),
                inNamespace: () => Effect.die("unused"),
                shownTo: () => Effect.die("unused"),
                visibility: () => Effect.void,
              }),
            ),
          ),
        ),
      );
      return runtime;
    });
    try {
      expect((await put("public")).status).toBe(200);
      expect(await listed(worker)).toContain(p.projectId);
      expect((await put("private")).status).toBe(200);
      expect(await listed(worker)).not.toContain(p.projectId);
    } finally {
      await runInDurableObject(stub, (instance: ProjectorDO) => {
        Reflect.set(instance, "runtime", repairing);
      });
    }
  });

  it("[projects.list-repair] the Projector writes the visibility of each settings event it receives, when no Project object wrote it", async () => {
    await pool();
    const projectId = await placed(POOL_ORG);
    const arrive = async (visibility: "private" | "public", seq: number) =>
      projector().receive([
        Schema.encodeSync(Envelope)(settingsChanged(projectId, visibility, seq)),
      ]);
    expect(await listed(worker)).not.toContain(projectId);
    await arrive("public", 3);
    await vi.waitFor(async () => expect(await listed(worker)).toContain(projectId), {
      timeout: 10_000,
      interval: 50,
    });
    await arrive("private", 4);
    await vi.waitFor(async () => expect(await listed(worker)).not.toContain(projectId), {
      timeout: 10_000,
      interval: 50,
    });
  });
});
