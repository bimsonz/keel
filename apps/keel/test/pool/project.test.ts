import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AgentId, makeId, type ProjectId, type UserId } from "@keeltown/core/kernel";
import { PROJECT_SETTINGS } from "@keeltown/core/application/integration";
import { type Actor, QuotaExceeded } from "@keeltown/core/domain/identity";
import {
  CodeHost,
  EntityStore,
  EventOutbox,
  ImportRefused,
  ImportTooLarge,
  Projects,
  RELAY_PACK_CAP_BYTES,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  sampleProjectId,
  type Upstreams,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { ProjectNamespacesD1 } from "../../src/adapters/driven/d1/project-namespaces.ts";
import { ProjectsRpc } from "../../src/adapters/driven/do-rpc/projects.ts";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { backbone } from "../../src/composition/do.ts";
import { decodeExit, ProjectCodecs } from "../../src/rpc/index.ts";
import { ok, refusal } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  placeProject,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";

const SOURCE = { namespace: "keel-core", name: "seed-app" };

/**
 * A Project DO reached over real RPC, running on an in-memory code host
 * (holding the source), trunk and pool instead of its composition's. Test-only:
 * the runtime is replaced from inside the object.
 */
async function projectUnderTest() {
  const projectId: ProjectId = makeId("prj", ulid());
  const operator: AgentId = makeId("agt", ulid());
  /** Who replaces the settings: a person, by id. */
  const maintainer: UserId = makeId("usr", ulid());
  const stub = drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));
  const journal: string[] = [];
  const code = makeCodeHostMemory();
  const trunks = makeTrunksMemory({ journal });
  const pool = makeWorkspacePoolMemory({ journal });
  await runInDurableObject(stub, (instance: ProjectDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(
          backbone(state.storage),
          code.layer,
          trunks.layer,
          pool.layer,
          ProjectNamespacesD1(env.DB),
        ),
      ),
    );
  });
  const head = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodeHost).create(SOURCE);
      return yield* (yield* CodeHostFixture).commit(SOURCE, "refs/heads/main", { "a.txt": "a" });
    }).pipe(Effect.provide(code.layer)),
  );
  const create = async (source = SOURCE.name, fingerprint = "body-1") =>
    decodeExit(
      ProjectCodecs.createProject,
      await stub.createProject({
        projectId,
        name: "Seed app",
        source: { _tag: "Template", repo: source },
        by: maintainer,
        actor: `user:${maintainer}`,
        idempotencyKey: "create-1",
        fingerprint,
      }),
    );
  const settings = async () => decodeExit(ProjectCodecs.settings, await stub.settings());
  const putSettings = async (
    put: {
      readonly protectedPaths: string[];
      readonly maxBatchSize: number;
      readonly verification?: "required" | "off";
      readonly visibility?: "private" | "public";
    },
    requestId: string,
  ) =>
    decodeExit(
      ProjectCodecs.putSettings,
      await stub.putSettings({
        projectId,
        settings: put,
        by: maintainer,
        actor: `user:${maintainer}`,
        requestId,
      }),
    );
  /** The project entity's events, in `seq` order. */
  const log = () =>
    runInDurableObject(stub, (instance: ProjectDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "project", id: projectId })),
      ),
    );
  /** Who creates the project, as the port takes them. */
  const creator: Actor = { _tag: "User", userId: maintainer };
  /** Runs a program against the Projects port over this object's RPC. */
  const through = <A, E>(
    program: (projects: (typeof Projects)["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromiseExit(
      Effect.flatMap(Projects, program).pipe(Effect.provide(ProjectsRpc(() => stub))),
    );
  return {
    projectId,
    stub,
    operator,
    maintainer,
    creator,
    through,
    code,
    journal,
    trunks,
    pool,
    head,
    create,
    settings,
    putSettings,
    log,
  };
}

const settingsChanges = async (p: Awaited<ReturnType<typeof projectUnderTest>>) =>
  (await p.log()).filter((event) => event.type === "ProjectSettingsChanged");

describe("the Project DO over real RPC", () => {
  it("[b11.bootstrap-order] bootstraps the project once, configuring its pool after trunk is synced", async () => {
    const p = await projectUnderTest();
    const view = ok(await p.create());
    const replayed = ok(await p.create());

    expect(view).toMatchObject({ id: p.projectId, name: "Seed app" });
    expect(replayed).toEqual(view);
    expect(p.trunks.heads.get(p.projectId)).toBe(p.head);
    expect(p.journal).toEqual([
      `initialize ${p.projectId}`,
      `sync ${p.projectId}`,
      `configure ${p.projectId}`,
    ]);
  });

  it("answers the code host's RepoNotFound for a missing source, and configures nothing", async () => {
    const p = await projectUnderTest();
    const missing = await p.create("no-such-repo");

    expect(Exit.isFailure(missing) && JSON.stringify(missing.cause)).toContain("RepoNotFound");
    expect(p.pool.configured.size).toBe(0);
  });
});

/** An import through the port over a fresh Project DO's RPC, whose trunk refuses its head with `refused` when given: what the port failed with, after checking no project and no pool came of it. */
const importRefusedAs = async (
  url: (upstreams: Upstreams) => string,
  refused?: QuotaExceeded | ImportTooLarge,
) => {
  const p = await projectUnderTest();
  if (refused !== undefined) p.trunks.refuse(p.projectId, refused);
  const upstreams = await Effect.runPromise(p.code.fixture.upstreams);
  const exit = await p.through((projects) =>
    Effect.flip(
      projects.create(p.creator, {
        projectId: p.projectId,
        name: "Seed app",
        source: { _tag: "Import", url: url(upstreams) },
        idempotencyKey: "create-1",
      }),
    ),
  );
  expect((await p.log()).map((event) => event.type)).toEqual([]);
  expect(p.pool.configured.size).toBe(0);
  return Exit.isSuccess(exit) ? exit.value : undefined;
};

describe("a project's start over real RPC", () => {
  it("[project.do.start-empty] an empty project crosses the Project DO's RPC as a start of its own: its trunk is seeded with the project's name, and the project is created", async () => {
    const p = await projectUnderTest();
    const made = await p.through((projects) =>
      projects.create(p.creator, {
        projectId: p.projectId,
        name: "Seed app",
        source: { _tag: "Empty" },
        idempotencyKey: "create-1",
      }),
    );
    expect(Exit.isSuccess(made) ? made.value : made).toMatchObject({
      id: p.projectId,
      name: "Seed app",
    });
    expect(p.trunks.seeded.get(p.projectId)?.name).toBe("Seed app");
    expect(p.trunks.origins.get(p.projectId)).toEqual({ kind: "empty" });
    expect((await p.log()).map((event) => event.type)).toEqual(["ProjectCreated"]);
  });

  it("[project.do.start-refused] a start the Project DO refuses crosses its RPC as the port's own error: the code host's ImportRefused, the quota's QuotaExceeded and the trunk's ImportTooLarge, with no project made", async () => {
    const quota = new QuotaExceeded({
      kind: "repo-bytes",
      reason: "limit",
      limit: 3_999,
      used: 0,
      requested: 4_000,
      nextActions: [],
    });
    const nothing = await importRefusedAs((upstreams) => upstreams.missing);
    expect(nothing).toBeInstanceOf(ImportRefused);
    expect(nothing).toMatchObject({ reason: "not-found" });

    const full = await importRefusedAs((upstreams) => upstreams.url, quota);
    expect(full).toBeInstanceOf(QuotaExceeded);
    expect(full).toMatchObject({ kind: "repo-bytes", limit: 3_999, requested: 4_000 });

    const over = new ImportTooLarge({
      projectId: "prj_any",
      bytes: RELAY_PACK_CAP_BYTES + 1,
      limit: RELAY_PACK_CAP_BYTES,
    });
    const tooLarge = await importRefusedAs((upstreams) => upstreams.url, over);
    expect(tooLarge).toBeInstanceOf(ImportTooLarge);
    expect(tooLarge).toMatchObject({
      bytes: RELAY_PACK_CAP_BYTES + 1,
      limit: RELAY_PACK_CAP_BYTES,
    });
  });
});

describe("a project's settings over real RPC", () => {
  it("[b12.settings-audit] answers the defaults, audits turning verification off, and commits nothing for an unchanged PUT", async () => {
    const p = await projectUnderTest();
    const beforeCreate = await p.settings();
    ok(await p.create());
    const defaults = ok(await p.settings());
    const off = ok(
      await p.putSettings({ protectedPaths: [], maxBatchSize: 1, verification: "off" }, "req-1"),
    );
    const unchanged = ok(
      await p.putSettings({ protectedPaths: [], maxBatchSize: 1, verification: "off" }, "req-2"),
    );
    const retried = ok(
      await p.putSettings({ protectedPaths: [], maxBatchSize: 1, verification: "off" }, "req-1"),
    );
    const changes = await settingsChanges(p);

    expect(refusal(beforeCreate)).toContain("ProjectNotFound");
    expect(defaults).toEqual({
      protectedPaths: [],
      maxBatchSize: 1,
      verification: "required",
      visibility: "private",
    });
    expect(off).toEqual({
      protectedPaths: [],
      maxBatchSize: 1,
      verification: "off",
      visibility: "private",
    });
    expect(ok(await p.settings())).toEqual(off);
    expect([unchanged, retried]).toEqual([off, off]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toEqual({
      _tag: "ProjectSettingsChanged",
      projectId: p.projectId,
      changes: [{ field: "verification", from: "required", to: "off" }],
      by: p.maintainer,
    });
    expect(changes[0]).toMatchObject({ actor: `user:${p.maintainer}`, project: p.projectId });
  });

  it("[b12.settings-audit] audits every field a PUT changes, and an absent verification turns it back on", async () => {
    const p = await projectUnderTest();
    ok(await p.create());
    ok(await p.putSettings({ protectedPaths: [], maxBatchSize: 1, verification: "off" }, "req-1"));
    const replaced = ok(
      await p.putSettings({ protectedPaths: ["infra/**"], maxBatchSize: 4 }, "req-2"),
    );
    const changes = await settingsChanges(p);

    expect(replaced).toEqual({
      protectedPaths: ["infra/**"],
      maxBatchSize: 4,
      verification: "required",
      visibility: "private",
    });
    expect(changes.map((event) => event.payload)).toMatchObject([
      { changes: [{ field: "verification", from: "required", to: "off" }] },
      {
        changes: [
          { field: "protectedPaths", from: [], to: ["infra/**"] },
          { field: "maxBatchSize", from: 1, to: 4 },
          { field: "verification", from: "off", to: "required" },
        ],
      },
    ]);
  });
});

/** A settings call through the real doorway: GET without a body, PUT with one. */
const settingsCall = (token: string, projectId: string, body?: object, requestId?: string) =>
  worker(`${BASE}/v1/projects/${projectId}/settings`, {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(requestId === undefined ? {} : { "x-request-id": requestId }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A maintainer of org `pool`, which the projects under test are placed in. */
const maintainer = async () => seedUser(uniqueHandle("maintainer"), { role: "maintainer" });

describe("a project's settings through the operator routes", () => {
  it("[b12.settings-operator] refuses an agent's token, and lets a maintainer of the project's org read and replace them", async () => {
    const p = await projectUnderTest();
    ok(await p.create());
    await placeProject(p.projectId);
    const agent = await tokenFor(await seedAgent());
    const user = await maintainer();
    const off = { protectedPaths: ["infra/**"], maxBatchSize: 1, verification: "off" };

    const agentGet = await settingsCall(agent, p.projectId);
    const agentPut = await settingsCall(agent, p.projectId, off);
    const put = await settingsCall(user.token, p.projectId, off);
    const got = await settingsCall(user.token, p.projectId);
    const changes = await settingsChanges(p);

    // The agent works in another project of the org: it reads none of this one, and governs nothing.
    expect(sampleProjectId).not.toBe(p.projectId);
    expect([agentGet.status, agentPut.status]).toEqual([403, 403]);
    expect([
      (await agentGet.json<{ detail: string }>()).detail,
      (await agentPut.json<{ detail: string }>()).detail,
    ]).toEqual(["Refused: foreign-project.", "Refused: users-only."]);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ...off, visibility: "private" });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ ...off, visibility: "private" });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor: `user:${user.userId}`,
      payload: { by: user.userId },
    });
  });

  it("[b12.settings-operator] answers 404 resource.not_found for a project that was never created", async () => {
    const user = await maintainer();
    const missing = makeId("prj", ulid());
    const response = await settingsCall(user.token, missing);
    const body = await response.json<{ code: string }>();

    expect(response.status).toBe(404);
    expect(body.code).toBe("resource.not_found");
  });

  it("[b12.settings-replay] answers a replayed request as it stands, and a reused request id with other settings 409", async () => {
    const p = await projectUnderTest();
    ok(await p.create());
    await placeProject(p.projectId);
    const user = (await maintainer()).token;
    const off = { protectedPaths: [], maxBatchSize: 1, verification: "off" };
    const other = { protectedPaths: ["infra/**"], maxBatchSize: 2 };
    const r1 = `r1-${ulid()}`;
    const r2 = `r2-${ulid()}`;

    const first = await settingsCall(user, p.projectId, off, r1);
    const replayed = await settingsCall(user, p.projectId, off, r1);
    const reused = await settingsCall(user, p.projectId, other, r1);
    // An unchanged PUT commits no event, and its request id is still spent.
    const unchanged = await settingsCall(user, p.projectId, off, r2);
    const reusedUnchanged = await settingsCall(user, p.projectId, other, r2);
    const body = await reused.json<{ code: string; nextActions: { operationId?: string }[] }>();

    expect([first.status, replayed.status, unchanged.status]).toEqual([200, 200, 200]);
    expect(await replayed.json()).toEqual({ ...off, visibility: "private" });
    expect([reused.status, reusedUnchanged.status]).toEqual([409, 409]);
    expect(body.code).toBe("request.idempotency_conflict");
    expect(body.nextActions.map((action) => action.operationId)).toEqual(["Operator_putSettings"]);
    expect(ok(await p.settings())).toEqual({ ...off, visibility: "private" });
    expect(await settingsChanges(p)).toHaveLength(1);
  });

  it("[b12.settings-visibility] keeps a public project public, audits each change, and reads settings stored before visibility as private", async () => {
    const p = await projectUnderTest();
    ok(await p.create());
    await placeProject(p.projectId);
    const user = (await maintainer()).token;
    const put = { protectedPaths: [], maxBatchSize: 1 };

    const published = await settingsCall(user, p.projectId, { ...put, visibility: "public" });
    const readPublic = await settingsCall(user, p.projectId);
    const hidden = await settingsCall(user, p.projectId, put);
    const changes = await settingsChanges(p);
    // A row written before `visibility` existed: the stored settings hold none.
    await runInDurableObject(p.stub, (instance: ProjectDO) =>
      instance["runtime"].runPromise(
        Effect.map(EntityStore, (store) =>
          store.put(PROJECT_SETTINGS, p.projectId, {
            protectedPaths: [],
            maxBatchSize: 3,
            verification: "required",
          }),
        ),
      ),
    );

    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ visibility: "public" });
    expect(await readPublic.json()).toMatchObject({ visibility: "public" });
    expect(await hidden.json()).toMatchObject({ visibility: "private" });
    expect(changes.map((event) => event.payload)).toMatchObject([
      { changes: [{ field: "visibility", from: "private", to: "public" }] },
      { changes: [{ field: "visibility", from: "public", to: "private" }] },
    ]);
    expect(ok(await p.settings())).toEqual({
      protectedPaths: [],
      maxBatchSize: 3,
      verification: "required",
      visibility: "private",
    });
  });
});
