import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AgentId, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost, EventOutbox } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  sampleProjectId,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { backbone } from "../../src/composition/do.ts";
import { decodeExit, ProjectCodecs } from "../../src/rpc/index.ts";
import { ok, refusal } from "./change-harness.ts";
import { BASE, seedAgent, tokenFor, worker } from "./helpers.ts";

const SOURCE = { namespace: "keel-core", name: "seed-app" };

/**
 * A Project DO reached over real RPC, running on an in-memory code host
 * (holding the source), trunk and pool instead of its composition's. Test-only:
 * the runtime is replaced from inside the object.
 */
async function projectUnderTest() {
  const projectId: ProjectId = makeId("prj", ulid());
  const operator: AgentId = makeId("agt", ulid());
  const stub = env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`));
  const journal: string[] = [];
  const code = makeCodeHostMemory();
  const trunks = makeTrunksMemory({ journal });
  const pool = makeWorkspacePoolMemory({ journal });
  await runInDurableObject(stub, (instance: ProjectDO, state) => {
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.mergeAll(backbone(state.storage), code.layer, trunks.layer, pool.layer),
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
        source,
        by: operator,
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
    },
    requestId: string,
  ) =>
    decodeExit(
      ProjectCodecs.putSettings,
      await stub.putSettings({ projectId, settings: put, by: operator, requestId }),
    );
  /** The project entity's events, in `seq` order. */
  const log = () =>
    runInDurableObject(stub, (instance: ProjectDO) =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "project", id: projectId })),
      ),
    );
  return { projectId, operator, journal, trunks, pool, head, create, settings, putSettings, log };
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
    expect(defaults).toEqual({ protectedPaths: [], maxBatchSize: 1, verification: "required" });
    expect(off).toEqual({ protectedPaths: [], maxBatchSize: 1, verification: "off" });
    expect(ok(await p.settings())).toEqual(off);
    expect([unchanged, retried]).toEqual([off, off]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toEqual({
      _tag: "ProjectSettingsChanged",
      projectId: p.projectId,
      changes: [{ field: "verification", from: "required", to: "off" }],
      by: p.operator,
    });
    expect(changes[0]).toMatchObject({ actor: `operator:${p.operator}`, project: p.projectId });
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

describe("a project's settings through the operator routes", () => {
  it("[b12.settings-operator] refuses an agent's token, and lets an operator of another project read and replace them", async () => {
    const p = await projectUnderTest();
    ok(await p.create());
    const agent = await tokenFor(await seedAgent());
    const operatorAgent = await seedAgent({}, ["operator"]);
    const operator = await tokenFor(operatorAgent);
    const off = { protectedPaths: ["infra/**"], maxBatchSize: 1, verification: "off" };

    const agentGet = await settingsCall(agent, p.projectId);
    const agentPut = await settingsCall(agent, p.projectId, off);
    const put = await settingsCall(operator, p.projectId, off);
    const got = await settingsCall(operator, p.projectId);
    const changes = await settingsChanges(p);

    // Operator authority is instance-wide at L1: this operator's token names another project.
    expect(operatorAgent.agent.projectId).toBe(sampleProjectId);
    expect(sampleProjectId).not.toBe(p.projectId);
    expect([agentGet.status, agentPut.status]).toEqual([403, 403]);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(off);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(off);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actor: `operator:${operatorAgent.agent.id}`,
      payload: { by: operatorAgent.agent.id },
    });
  });

  it("[b12.settings-operator] answers 404 with a next action for a project that was never created", async () => {
    const operator = await tokenFor(await seedAgent({}, ["operator"]));
    const missing = makeId("prj", ulid());
    const response = await settingsCall(operator, missing);
    const body = await response.json<{ nextActions: { operationId?: string }[] }>();

    expect(response.status).toBe(404);
    expect(body.nextActions.map((action) => action.operationId)).toEqual([
      "Operator_createProject",
    ]);
  });

  it("[b12.settings-replay] answers a replayed request as it stands, and a reused request id with other settings 409", async () => {
    const p = await projectUnderTest();
    ok(await p.create());
    const operator = await tokenFor(await seedAgent({}, ["operator"]));
    const off = { protectedPaths: [], maxBatchSize: 1, verification: "off" };
    const other = { protectedPaths: ["infra/**"], maxBatchSize: 2 };
    const r1 = `r1-${ulid()}`;
    const r2 = `r2-${ulid()}`;

    const first = await settingsCall(operator, p.projectId, off, r1);
    const replayed = await settingsCall(operator, p.projectId, off, r1);
    const reused = await settingsCall(operator, p.projectId, other, r1);
    // An unchanged PUT commits no event, and its request id is still spent.
    const unchanged = await settingsCall(operator, p.projectId, off, r2);
    const reusedUnchanged = await settingsCall(operator, p.projectId, other, r2);
    const body = await reused.json<{ code: string; nextActions: { operationId?: string }[] }>();

    expect([first.status, replayed.status, unchanged.status]).toEqual([200, 200, 200]);
    expect(await replayed.json()).toEqual(off);
    expect([reused.status, reusedUnchanged.status]).toEqual([409, 409]);
    expect(body.code).toBe("request.idempotency_conflict");
    expect(body.nextActions.map((action) => action.operationId)).toEqual(["Operator_putSettings"]);
    expect(ok(await p.settings())).toEqual(off);
    expect(await settingsChanges(p)).toHaveLength(1);
  });
});
