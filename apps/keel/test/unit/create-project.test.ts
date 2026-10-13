import { describe, expect, it } from "@effect/vitest";
import { createProject, projectRepos } from "@keeltown/core/application/integration";
import { ProjectId, UserId } from "@keeltown/core/kernel";
import { CodeHost, EventOutbox } from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeManualClock,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";

const projectId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const creator = Schema.decodeUnknownSync(UserId)("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const SOURCE = { namespace: "keel-core", name: "seed-app" };
const POOL_TARGET = 2;

/** A Project DO's state in memory, beside a code host holding the source, a trunk and a pool that journal their calls. */
function bootstrap(options: { readonly failSyncOnce?: boolean } = {}) {
  const journal: string[] = [];
  const code = makeCodeHostMemory();
  const trunks = makeTrunksMemory({ journal, ...options });
  const pool = makeWorkspacePoolMemory({ journal });
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeManualClock().layer,
    code.layer,
    trunks.layer,
    pool.layer,
  );
  return { journal, trunks, pool, layer };
}

const creating = (idempotencyKey = "create-1", fingerprint = "body-1", source = SOURCE.name) => ({
  projectId,
  name: "Seed app",
  source,
  by: creator,
  idempotencyKey,
  fingerprint,
});

/** The source repo with one commit on main, as the operator's seed leaves it. */
const seedSource = Effect.gen(function* () {
  yield* (yield* CodeHost).create(SOURCE);
  return yield* (yield* CodeHostFixture).commit(SOURCE, "refs/heads/main", { "README.md": "seed" });
});

const projectEvents = Effect.map(EventOutbox, (outbox) =>
  outbox.log({ kind: "project", id: projectId }).map((event) => event.type),
);

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded";

describe("createProject", () => {
  it.effect(
    "[b11.bootstrap-order] forks trunk and staging, creates the mirror, initializes and syncs trunk, configures the pool last, then commits ProjectCreated",
    () => {
      const { journal, trunks, pool, layer } = bootstrap();
      return Effect.gen(function* () {
        const head = yield* seedSource;
        const project = yield* createProject(creating(), POOL_TARGET);
        const repos = projectRepos(projectId);
        const host = yield* CodeHost;

        expect(project).toMatchObject({ id: projectId, name: "Seed app" });
        expect(yield* host.head(repos.trunk, "refs/heads/main")).toBe(head);
        expect(yield* host.head(repos.staging, "refs/heads/main")).toBe(head);
        expect((yield* Effect.exit(host.info(repos.mirror)))._tag).toBe("Success");
        expect(trunks.heads.get(projectId)).toBe(head);
        expect(journal).toEqual([
          `initialize ${projectId}`,
          `sync ${projectId}`,
          `configure ${projectId}`,
        ]);
        expect(pool.configured.get(projectId)).toEqual({
          source: repos.mirror,
          target: POOL_TARGET,
        });
        expect(yield* projectEvents).toEqual(["ProjectCreated"]);
        const [created] = (yield* EventOutbox).log({ kind: "project", id: projectId });
        expect(created).toMatchObject({ actor: `user:${creator}`, payload: { by: creator } });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b11.bootstrap-replay] answers a replay of the key from what it committed, touching nothing",
    () => {
      const { journal, layer } = bootstrap();
      return Effect.gen(function* () {
        yield* seedSource;
        const first = yield* createProject(creating(), POOL_TARGET);
        const calls = journal.length;
        const replayed = yield* createProject(creating(), POOL_TARGET);
        const reused = yield* Effect.exit(
          createProject(creating("create-1", "body-2"), POOL_TARGET),
        );

        expect(replayed).toEqual(first);
        expect(journal).toHaveLength(calls);
        expect(failureOf(reused)).toContain("IdempotencyConflict");
        expect(yield* projectEvents).toEqual(["ProjectCreated"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b11.bootstrap-crash] finishes on a retry after a crash mid-way, redoing only what is idempotent",
    () => {
      const { journal, pool, layer } = bootstrap({ failSyncOnce: true });
      return Effect.gen(function* () {
        const head = yield* seedSource;
        const crashed = yield* Effect.exit(createProject(creating(), POOL_TARGET));
        const configuredAfterCrash = pool.configured.size;
        const project = yield* createProject(creating(), POOL_TARGET);
        const repos = projectRepos(projectId);

        expect(Exit.isFailure(crashed)).toBe(true);
        expect(configuredAfterCrash).toBe(0);
        expect(project.id).toBe(projectId);
        expect(yield* (yield* CodeHost).head(repos.trunk, "refs/heads/main")).toBe(head);
        expect(journal.slice(-2)).toEqual([`sync ${projectId}`, `configure ${projectId}`]);
        expect(yield* projectEvents).toEqual(["ProjectCreated"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fails RepoNotFound for a source that does not exist, and configures nothing", () => {
    const { pool, layer } = bootstrap();
    return Effect.gen(function* () {
      const missing = yield* Effect.exit(
        createProject(creating("create-1", "body-1", "no-such-repo"), POOL_TARGET),
      );

      expect(failureOf(missing)).toContain("RepoNotFound");
      expect(pool.configured.size).toBe(0);
      expect(yield* projectEvents).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
