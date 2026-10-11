import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AgentId, makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { backbone } from "../../src/composition/do.ts";
import { decodeExit, ProjectCodecs } from "../../src/rpc/index.ts";
import { ok } from "./change-harness.ts";

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
  return { projectId, journal, trunks, pool, head, create };
}

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
