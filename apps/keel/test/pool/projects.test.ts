// The Projects contract through the real Project DO, over RPC. The pool
// cannot reach the core namespace (Artifacts has no local simulator), so each
// Project DO runs its use-cases on an in-memory code host holding the source,
// an in-memory trunk and pool, as project.test.ts does: what this proves is the
// adapter, the DO's RPC and codecs, and its decisions.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentToken } from "@keeltown/core/domain/identity";
import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { CodeHost, Projects } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  PORTS,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import type { ProjectDO } from "../../src/adapters/driving/do/project.ts";
import { ProjectsRpc, type ProjectStub } from "../../src/adapters/driven/do-rpc/projects.ts";
import { backbone } from "../../src/composition/do.ts";

PORTS.Projects.contract("Project DO over RPC", () => {
  const code = makeCodeHostMemory();
  const source = `source-${ulid().toLowerCase()}`;
  const ready = Effect.runPromise(
    Effect.gen(function* () {
      const repo = { namespace: "keel-core", name: source };
      yield* (yield* CodeHost).create(repo);
      yield* (yield* CodeHostFixture).commit(repo, "refs/heads/main", { "README.md": "forge" });
    }).pipe(Effect.provide(code.layer)),
  );
  const rewired = new Map<ProjectId, Promise<void>>();
  /** The project's DO, on the in-memory driven adapters from its first call on. */
  const project = (projectId: ProjectId): ProjectStub => {
    const stub = env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`));
    const onMemory = async () => {
      await ready;
      if (!rewired.has(projectId)) {
        rewired.set(
          projectId,
          runInDurableObject(stub, (instance: ProjectDO, state) => {
            const driven = Layer.mergeAll(
              code.layer,
              makeTrunksMemory().layer,
              makeWorkspacePoolMemory().layer,
            );
            Reflect.set(
              instance,
              "runtime",
              ManagedRuntime.make(Layer.mergeAll(backbone(state.storage), driven)),
            );
          }),
        );
      }
      await rewired.get(projectId);
    };
    return {
      createProject: async (command) => (await onMemory(), stub.createProject(command)),
      settings: async () => (await onMemory(), stub.settings()),
      putSettings: async (command) => (await onMemory(), stub.putSettings(command)),
    };
  };
  const layer = ProjectsRpc(project);
  return {
    layer,
    source,
    withSettings: (settings) =>
      Effect.gen(function* () {
        const projects = yield* Projects;
        const by: AgentToken = {
          agentId: makeId("agt", ulid()),
          projectId: makeId("prj", ulid()),
          scopes: ["operator"],
          revocationEpoch: 0,
        };
        const created = yield* projects.create(by, {
          name: "forge",
          source,
          idempotencyKey: `key-${crypto.randomUUID()}`,
        });
        yield* projects.putSettings(by, created.id, settings, `req-${crypto.randomUUID()}`);
        return created.id;
      }).pipe(Effect.orDie, Effect.provide(layer)),
  };
});
