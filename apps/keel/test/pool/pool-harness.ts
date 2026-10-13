// What a test gives a real WorkspacePool object before it configures it, and
// a real Trunk object before it initializes it. A pool with a ready workspace
// asks its project's Trunk DO for trunk's head, to keep its workspaces on it;
// a test that stocks a pool for a project with no trunk of its own gives the
// object one here, as createProject would have. A trunk counts against its
// project's org; a test that runs one on memory adapters gives it the place
// creating the project would have written.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { PushRejected } from "@keeltown/core/domain/integration";
import type { CommitSha, NamespaceId, ProjectId } from "@keeltown/core/kernel";
import { CodeHost, Trunks, WorkspaceRefresher } from "@keeltown/core/ports";
import { makeProjectNamespacesMemory } from "@keeltown/testing";
import { Effect, Layer } from "effect";
import type { WorkspacePoolDO } from "../../src/adapters/driving/do/workspace-pool.ts";
import { codeHostLayer, type PoolServices } from "../../src/composition/do.ts";
import { POOL_ORG } from "./helpers.ts";

/**
 * A ProjectNamespaces in memory that holds `projectId`'s place in `org`, as
 * creating the project writes it before its trunk exists. A Trunk object run
 * on memory adapters takes its layer: a project with no place has no trunk.
 */
export function placedIn(projectId: ProjectId, org: NamespaceId = POOL_ORG) {
  const places = makeProjectNamespacesMemory();
  places.places.set(projectId, { projectId, namespace: org, name: projectId.toLowerCase() });
  return places;
}

/** What a pool's object follows in a test: the trunk it asks for a head, and the refresher it relays through. */
export interface Followed {
  /** Trunk's head, as the project's Trunk DO would answer. Unset, it is the mirror's: no workspace is ever behind. */
  head: CommitSha | undefined;
  /** Each relay the pool asked for, in order. */
  readonly relays: { workspace: string; from: string; to: string }[];
  /** While true, a relay waits before it answers. */
  held: boolean;
  /** How a relay answers: the workspace moved, or it stayed busy and nothing moved. */
  answer: "advanced" | "busy";
}

/** Any Trunks method but `head`. */
const unused = () => Effect.die(new Error("the pool asks trunk for its head only"));

/**
 * Puts a trunk and a refresher of the test's own into `projectId`'s pool
 * object, in place of the project's Trunk DO and of GitCore: the fake
 * namespace holds no git content to relay, and the project has no trunk. The
 * code host stays the real adapter. `source` is the mirror the pool forks
 * from. Call it before the pool is configured.
 */
export async function followTrunk(
  projectId: string,
  source: { readonly namespace: string; readonly name: string },
): Promise<Followed> {
  const followed: Followed = { head: undefined, relays: [], held: false, answer: "advanced" };
  const host = codeHostLayer(env);
  const trunks = Layer.succeed(
    Trunks,
    Trunks.of({
      head: () =>
        followed.head === undefined
          ? Effect.flatMap(CodeHost, (code) => code.head(source, "refs/heads/main")).pipe(
              Effect.provide(host),
              Effect.orDie,
            )
          : Effect.succeed(followed.head),
      initialize: unused,
      adopt: unused,
      seed: unused,
      sync: unused,
      destroy: unused,
    }),
  );
  const refresher = Layer.succeed(
    WorkspaceRefresher,
    WorkspaceRefresher.of({
      advance: (_projectId, workspace, from, to) =>
        Effect.gen(function* () {
          followed.relays.push({ workspace: workspace.name, from, to });
          // Waited out on the object's own timer, so nothing crosses from the test's request into the alarm's.
          yield* Effect.promise(async () => {
            while (followed.held) await new Promise((resolve) => setTimeout(resolve, 20));
          });
          if (followed.answer === "busy")
            return yield* Effect.fail(new PushRejected({ reason: "busy" }));
          return "advanced" as const;
        }),
    }),
  );
  const services: Layer.Layer<PoolServices> = Layer.mergeAll(host, trunks, refresher);
  const pool = env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(`pool:${projectId}`));
  await runInDurableObject(pool, (instance: WorkspacePoolDO) => {
    Reflect.set(instance, "services", services);
  });
  return followed;
}
