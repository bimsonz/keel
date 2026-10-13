// A real Project DO for the doorway's reads: created over in-memory code, trunk
// and pool, placed in org `pool`, private as created, and made public by a
// maintainer through the settings route.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeId } from "@keeltown/core/kernel";
import { CodeHost } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  projectEvents,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { expect } from "vitest";
import { ProjectNamespacesD1 } from "../../src/adapters/driven/d1/project-namespaces.ts";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { backbone } from "../../src/composition/do.ts";
import { decodeExit, ProjectCodecs } from "../../src/rpc/index.ts";
import { ok } from "./change-harness.ts";
import { BASE, drainAfter, drainOutbox, placeProject, seedUser, worker } from "./helpers.ts";

const SOURCE = { namespace: "keel-core", name: "seed-app" };

/** A created project, placed in org `pool` and private as created; `open()` has a maintainer make it public through the settings route. */
export async function project() {
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
          // The settings route writes the project's visibility to its place's row.
          ProjectNamespacesD1(env.DB),
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
  const creator = makeId("usr", ulid());
  ok(
    decodeExit(
      ProjectCodecs.createProject,
      await stub.createProject({
        projectId,
        name: "Seed app",
        source: { _tag: "Template", repo: SOURCE.name },
        by: creator,
        actor: `user:${creator}`,
        idempotencyKey: "create-1",
        fingerprint: "body-1",
      }),
    ),
  );
  await drainOutbox(stub);
  await placeProject(projectId);
  const open = async () => {
    const maintainer = await seedUser(`open-${ulid().toLowerCase()}`, { role: "maintainer" });
    const put = await worker(`${BASE}/v1/projects/${projectId}/settings`, {
      method: "PUT",
      headers: { authorization: `Bearer ${maintainer.token}`, "content-type": "application/json" },
      body: JSON.stringify({ protectedPaths: [], maxBatchSize: 1, visibility: "public" }),
    });
    expect(put.status).toBe(200);
    await drainOutbox(stub);
  };
  return { projectId, events: projectEvents(projectId), open };
}
