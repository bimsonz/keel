import { describe, expect, it } from "@effect/vitest";
import { createProject, projectRepos } from "@keeltown/core/application/integration";
import { QuotaExceeded } from "@keeltown/core/domain/identity";
import { type Instant, ProjectId, UserId } from "@keeltown/core/kernel";
import {
  CodeHost,
  EventOutbox,
  ImportTooLarge,
  type ProjectSource,
  RELAY_PACK_CAP_BYTES,
  type RepoRef,
  Trunks,
} from "@keeltown/core/ports";
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
const parentId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const creator = Schema.decodeUnknownSync(UserId)("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const SOURCE = { namespace: "keel-core", name: "seed-app" };
const TEMPLATE: ProjectSource = { _tag: "Template", repo: SOURCE.name };
const MAIN = "refs/heads/main";
const POOL_TARGET = 2;

/**
 * A Project DO's state in memory, beside a code host holding the source, a
 * trunk and a pool that journal their calls. The memory trunk's first writes
 * land in the memory code host, as the real writer's land in trunk's repo:
 * an adopt makes main there, and a seed commits a README. `loseSeedOnce`
 * makes the first seed die before it writes, as a push whose answer and
 * effect were both lost.
 */
function bootstrap(
  options: { readonly failSyncOnce?: boolean; readonly loseSeedOnce?: boolean } = {},
) {
  const journal: string[] = [];
  const code = makeCodeHostMemory();
  const clock = makeManualClock();
  const memory = makeTrunksMemory({
    journal,
    ...(options.failSyncOnce === undefined ? {} : { failSyncOnce: options.failSyncOnce }),
  });
  const pool = makeWorkspacePoolMemory({ journal });
  const seedsAsked: { readonly name: string; readonly at: Instant }[] = [];
  let seedsToLose = options.loseSeedOnce === true ? 1 : 0;
  const refsOf = (repo: RepoRef) => code.repos.get(`${repo.namespace}/${repo.name}`)?.refs;
  const trunks = Layer.effect(
    Trunks,
    Effect.map(Trunks, (inner) =>
      Trunks.of({
        ...inner,
        adopt: (id, commit) =>
          Effect.tap(inner.adopt(id, commit), () =>
            Effect.sync(() => void refsOf(projectRepos(id).trunk)?.set(MAIN, commit)),
          ),
        seed: (id, name, at) =>
          Effect.suspend(() => {
            seedsAsked.push({ name, at });
            if (seedsToLose > 0) {
              seedsToLose -= 1;
              return Effect.die(new Error("the seed's push was lost"));
            }
            return inner
              .seed(id, name, at)
              .pipe(
                Effect.andThen(
                  code.fixture.commit(projectRepos(id).trunk, MAIN, { "README.md": `# ${name}\n` }),
                ),
                Effect.orDie,
              );
          }),
      }),
    ),
  ).pipe(Layer.provide(memory.layer));
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    clock.layer,
    code.layer,
    trunks,
    pool.layer,
  );
  return { journal, code, clock, trunks: memory, pool, seedsAsked, layer };
}

const creating = (
  idempotencyKey = "create-1",
  fingerprint = "body-1",
  source: ProjectSource = TEMPLATE,
) => ({
  projectId,
  name: "Seed app",
  source,
  by: creator,
  idempotencyKey,
  fingerprint,
});

/** A project started as `source`, under the first key. */
const starting = (source: ProjectSource) => creating("create-1", "body-1", source);

/** Whether the code host holds the repo. */
const held = (repo: RepoRef) =>
  Effect.map(Effect.exit(Effect.flatMap(CodeHost, (host) => host.info(repo))), Exit.isSuccess);

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
        expect(trunks.origins.get(projectId)).toEqual({
          kind: "template",
          name: SOURCE.name,
          commit: head,
        });
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
        createProject(starting({ _tag: "Template", repo: "no-such-repo" }), POOL_TARGET),
      );

      expect(failureOf(missing)).toContain("RepoNotFound");
      expect(pool.configured.size).toBe(0);
      expect(yield* projectEvents).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("createProject by start", () => {
  it.effect(
    "[project.start-fork] a fork takes the other project's trunk, and its origin names that project and the head it was forked at",
    () => {
      const { trunks, layer } = bootstrap();
      return Effect.gen(function* () {
        const parent = projectRepos(parentId).trunk;
        yield* (yield* CodeHost).create(parent);
        const head = yield* (yield* CodeHostFixture).commit(parent, MAIN, {
          "README.md": "parent",
        });
        yield* createProject(starting({ _tag: "Project", projectId: parentId }), POOL_TARGET);
        expect(yield* (yield* CodeHost).head(projectRepos(projectId).trunk, MAIN)).toBe(head);
        expect(trunks.heads.get(projectId)).toBe(head);
        expect(trunks.origins.get(projectId)).toEqual({
          kind: "forked",
          project: parentId,
          commit: head,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.start-empty] an empty project's trunk is created and seeded once, with the project's name at the time its bootstrap began, and initialized at that commit with an empty origin; a retry after a crash asks for no second seed",
    () => {
      const { journal, clock, trunks, seedsAsked, layer } = bootstrap({ failSyncOnce: true });
      return Effect.gen(function* () {
        const began = clock.now();
        const crashed = yield* Effect.exit(createProject(starting({ _tag: "Empty" }), POOL_TARGET));
        expect(Exit.isFailure(crashed)).toBe(true);
        clock.advance(60_000);
        const project = yield* createProject(starting({ _tag: "Empty" }), POOL_TARGET);
        const repos = projectRepos(projectId);
        const host = yield* CodeHost;
        const seed = yield* host.head(repos.trunk, MAIN);

        expect(project.id).toBe(projectId);
        expect(seedsAsked).toEqual([{ name: "Seed app", at: began }]);
        expect(trunks.heads.get(projectId)).toBe(seed);
        expect(trunks.origins.get(projectId)).toEqual({ kind: "empty" });
        expect(yield* host.head(repos.staging, MAIN)).toBe(seed);
        expect(journal).toEqual([
          `seed ${projectId}`,
          `initialize ${projectId}`,
          `initialize ${projectId}`,
          `sync ${projectId}`,
          `configure ${projectId}`,
        ]);
        expect(yield* projectEvents).toEqual(["ProjectCreated"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.seed-time] a retry after the first commit's push was lost asks for the same commit again: the same name, at the time the bootstrap first began, though the clock has moved",
    () => {
      const { clock, seedsAsked, layer } = bootstrap({ loseSeedOnce: true });
      return Effect.gen(function* () {
        const began = clock.now();
        const lost = yield* Effect.exit(createProject(starting({ _tag: "Empty" }), POOL_TARGET));
        expect(Exit.isFailure(lost)).toBe(true);
        clock.advance(60_000);
        yield* createProject(starting({ _tag: "Empty" }), POOL_TARGET);
        expect(seedsAsked).toEqual([
          { name: "Seed app", at: began },
          { name: "Seed app", at: began },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.import-not-main] an import takes the upstream's default branch under its own name, the trunk's writer makes main at its head, and the origin records the URL, the branch that came and its head; a retry after a crash imports and adopts nothing again",
    () => {
      const { journal, trunks, layer } = bootstrap({ failSyncOnce: true });
      return Effect.gen(function* () {
        const upstream = yield* (yield* CodeHostFixture).upstreams;
        const source: ProjectSource = { _tag: "Import", url: upstream.url };
        const crashed = yield* Effect.exit(createProject(starting(source), POOL_TARGET));
        expect(Exit.isFailure(crashed)).toBe(true);
        yield* createProject(starting(source), POOL_TARGET);
        const repos = projectRepos(projectId);
        const host = yield* CodeHost;
        const came = upstream.byDefault;

        expect(yield* host.branches(repos.trunk)).toEqual([
          { ref: MAIN, commit: came.commit },
          { ref: came.ref, commit: came.commit },
        ]);
        expect(trunks.adopted.get(projectId)).toBe(came.commit);
        expect(trunks.heads.get(projectId)).toBe(came.commit);
        expect(trunks.origins.get(projectId)).toEqual({
          kind: "imported",
          url: upstream.url,
          ref: came.ref,
          commit: came.commit,
        });
        expect(yield* host.head(repos.staging, MAIN)).toBe(came.commit);
        expect(journal).toEqual([
          `adopt ${projectId}`,
          `initialize ${projectId}`,
          `initialize ${projectId}`,
          `sync ${projectId}`,
          `configure ${projectId}`,
        ]);
        expect(yield* projectEvents).toEqual(["ProjectCreated"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.start-import] an import that names a branch takes that one, and one that came as main alone needs no main made: its origin names main",
    () => {
      const named = bootstrap();
      const asMain = bootstrap();
      return Effect.gen(function* () {
        const upstream = yield* Effect.provide(
          Effect.flatMap(CodeHostFixture, (fixture) => fixture.upstreams),
          named.layer,
        );
        yield* createProject(
          starting({ _tag: "Import", url: upstream.url, ref: upstream.other.name }),
          POOL_TARGET,
        ).pipe(Effect.provide(named.layer));
        expect(named.trunks.adopted.get(projectId)).toBe(upstream.other.commit);
        expect(named.trunks.origins.get(projectId)).toEqual({
          kind: "imported",
          url: upstream.url,
          ref: upstream.other.ref,
          commit: upstream.other.commit,
        });

        // A trunk that an earlier try imported, whose one branch is main.
        const head = yield* Effect.gen(function* () {
          const trunk = projectRepos(projectId).trunk;
          yield* (yield* CodeHost).create(trunk);
          const at = yield* (yield* CodeHostFixture).commit(trunk, MAIN, { "README.md": "main" });
          yield* createProject(
            starting({ _tag: "Import", url: "https://git.example/team/app" }),
            POOL_TARGET,
          );
          return at;
        }).pipe(Effect.provide(asMain.layer));
        expect(asMain.journal).not.toContain(`adopt ${projectId}`);
        expect(asMain.trunks.origins.get(projectId)).toEqual({
          kind: "imported",
          url: "https://git.example/team/app",
          ref: MAIN,
          commit: head,
        });
      });
    },
  );

  it.effect(
    "[project.import-refused] an import the code host takes nothing from fails as the host said it: no repo, no trunk, no pool and no project",
    () => {
      const { journal, pool, layer } = bootstrap();
      return Effect.gen(function* () {
        const upstream = yield* (yield* CodeHostFixture).upstreams;
        const refusals = yield* Effect.forEach(
          [
            { _tag: "Import", url: upstream.missing },
            { _tag: "Import", url: upstream.notGit },
            { _tag: "Import", url: upstream.url, ref: "no-such-branch" },
          ] satisfies ProjectSource[],
          (source) => Effect.flip(createProject(starting(source), POOL_TARGET)),
        );
        expect(refusals).toMatchObject([
          { _tag: "ImportRefused", reason: "not-found" },
          { _tag: "ImportRefused", reason: "not-git" },
          { _tag: "ImportRefused", reason: "no-branch" },
        ]);
        expect(yield* held(projectRepos(projectId).trunk)).toBe(false);
        expect(journal).toEqual([]);
        expect(pool.configured.size).toBe(0);
        expect(yield* projectEvents).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  for (const refusal of [
    new QuotaExceeded({
      kind: "repo-bytes",
      reason: "limit",
      limit: 3_999,
      used: 0,
      requested: 4_000,
      nextActions: [],
    }),
    new ImportTooLarge({
      projectId,
      bytes: RELAY_PACK_CAP_BYTES + 1,
      limit: RELAY_PACK_CAP_BYTES,
    }),
  ])
    it.effect(
      `[project.import-over-quota] an import its trunk refuses a head (${refusal._tag}) fails with that refusal, and the imported repo is deleted: no staging, no mirror, no pool and no project`,
      () => {
        const { journal, trunks, pool, layer } = bootstrap();
        trunks.refuse(projectId, refusal);
        return Effect.gen(function* () {
          const upstream = yield* (yield* CodeHostFixture).upstreams;
          const refused = yield* Effect.flip(
            createProject(starting({ _tag: "Import", url: upstream.url }), POOL_TARGET),
          );
          const repos = projectRepos(projectId);
          expect(refused).toEqual(refusal);
          expect([
            yield* held(repos.trunk),
            yield* held(repos.staging),
            yield* held(repos.mirror),
          ]).toEqual([false, false, false]);
          expect(trunks.heads.has(projectId)).toBe(false);
          expect(journal).toEqual([`adopt ${projectId}`]);
          expect(pool.configured.size).toBe(0);
          expect(yield* projectEvents).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );
});
