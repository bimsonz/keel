import { describe, expect, it } from "@effect/vitest";
import {
  createProject,
  finishFailed,
  finishOf,
  finishProject,
  holdPool,
  projectRepos,
} from "@keeltown/core/application/integration";
import { QuotaExceeded } from "@keeltown/core/domain/identity";
import {
  AgentId,
  agentActor,
  type CommitSha,
  Instant,
  ProjectId,
  RunRef,
  userActor,
  UserId,
} from "@keeltown/core/kernel";
import {
  CodeHost,
  commit,
  EntityStore,
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
import { Effect, Exit, Layer, Result, Schema } from "effect";

const projectId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const parentId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V1");
const goneId = Schema.decodeUnknownSync(ProjectId)("prj_01JZ8PT2C4E6G8J0M2N4Q6S8V2");
const creator = Schema.decodeUnknownSync(UserId)("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const SOURCE = { namespace: "keel-core", name: "seed-app" };
const TEMPLATE: ProjectSource = { _tag: "Template", repo: SOURCE.name };
const MAIN = "refs/heads/main";
const POOL_TARGET = 2;

/** The whole bootstrap: the create, then the finish the Project DO's deadline runs after it answers. */
const bootstrapped = (command: Parameters<typeof createProject>[0]) =>
  createProject(command).pipe(Effect.tap(() => finishProject(command.projectId, POOL_TARGET)));

/**
 * A Project DO's state in memory, beside a code host holding the source, a
 * trunk and a pool that journal their calls. The memory trunk's first writes
 * land in the memory code host, as the real writer's land in trunk's repo:
 * an adopt makes main there, a seed commits a README, and a take brings the
 * source trunk's objects and makes main at its head (the memory trunks do
 * that themselves, given the host). `loseSeedOnce` makes
 * the first seed die before it writes, as a push whose answer and effect
 * were both lost, and `loseTakeOnce` the first take. `failMirrorTimes`
 * makes the mirror's create die that many times. `hostCalls` is every
 * repo the code host was asked to make or delete, and how.
 */
function bootstrap(
  options: {
    readonly failSyncOnce?: boolean;
    readonly loseSeedOnce?: boolean;
    readonly loseTakeOnce?: boolean;
    readonly failMirrorTimes?: number;
  } = {},
) {
  const journal: string[] = [];
  const code = makeCodeHostMemory();
  const hostCalls: string[] = [];
  let mirrorFailures = options.failMirrorTimes ?? 0;
  const host = Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (inner) =>
      CodeHost.of({
        ...inner,
        create: (repo) => {
          hostCalls.push(`create ${nameOf(repo)}`);
          if (mirrorFailures > 0 && nameOf(repo) === nameOf(projectRepos(projectId).mirror)) {
            mirrorFailures -= 1;
            return Effect.die(new Error("the mirror's create failed"));
          }
          return inner.create(repo);
        },
        fork: (source, target) => {
          hostCalls.push(`fork ${nameOf(source)} as ${nameOf(target)}`);
          return inner.fork(source, target);
        },
        delete: (repo) => {
          hostCalls.push(`delete ${nameOf(repo)}`);
          return inner.delete(repo);
        },
      }),
    ),
  ).pipe(Layer.provide(code.layer));
  const clock = makeManualClock();
  const memory = makeTrunksMemory({
    journal,
    host: code,
    ...(options.failSyncOnce === undefined ? {} : { failSyncOnce: options.failSyncOnce }),
  });
  const pool = makeWorkspacePoolMemory({ journal });
  const seedsAsked: { readonly name: string; readonly at: Instant }[] = [];
  let seedsToLose = options.loseSeedOnce === true ? 1 : 0;
  const takesAsked: ProjectId[] = [];
  let takesToLose = options.loseTakeOnce === true ? 1 : 0;
  const refsOf = (repo: RepoRef) => code.repos.get(nameOf(repo))?.refs;
  const trunks = Layer.effect(
    Trunks,
    Effect.map(Trunks, (inner) =>
      Trunks.of({
        ...inner,
        adopt: (id, sha) =>
          Effect.tap(inner.adopt(id, sha), () =>
            Effect.sync(() => void refsOf(projectRepos(id).trunk)?.set(MAIN, sha)),
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
        take: (id, source) =>
          Effect.suspend(() => {
            takesAsked.push(source);
            if (takesToLose > 0) {
              takesToLose -= 1;
              return Effect.die(new Error("the take's relay was lost"));
            }
            return inner.take(id, source);
          }),
      }),
    ),
  ).pipe(Layer.provide(memory.layer));
  const layer = Layer.mergeAll(
    makeEventOutboxMemory().layer,
    clock.layer,
    host,
    Layer.succeed(CodeHostFixture, code.fixture),
    trunks,
    pool.layer,
  );
  return {
    journal,
    code,
    hostCalls,
    clock,
    trunks: memory,
    pool,
    seedsAsked,
    takesAsked,
    layer,
  };
}

/** A repo as the journal of the code host's calls names it. */
function nameOf(repo: RepoRef) {
  return `${repo.namespace}/${repo.name}`;
}

/** The project a fork names: its trunk's repo with one commit on main, and its trunk initialized there. */
const parentProject = (trunks: { readonly heads: Map<ProjectId, CommitSha> }) =>
  Effect.gen(function* () {
    const parent = projectRepos(parentId).trunk;
    yield* (yield* CodeHost).create(parent);
    const head = yield* (yield* CodeHostFixture).commit(parent, MAIN, { "README.md": "parent" });
    trunks.heads.set(parentId, head);
    return head;
  });

const creating = (
  idempotencyKey = "create-1",
  fingerprint = "body-1",
  source: ProjectSource = TEMPLATE,
) => ({
  projectId,
  name: "Seed app",
  source,
  by: creator,
  actor: userActor(creator),
  idempotencyKey,
  fingerprint,
});

/** A project started as `source`, under the first key. */
const starting = (source: ProjectSource) => creating("create-1", "body-1", source);

const createProjectOf = (source: ProjectSource) =>
  Effect.suspend(() => bootstrapped(starting(source)));

/** The project, started as a fork of the parent. */
const forking = createProjectOf({ _tag: "Project", projectId: parentId });

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
    "[b11.bootstrap-order] makes trunk, initializes it and commits ProjectCreated; the finish then forks staging, creates the mirror, syncs trunk and configures the pool last",
    () => {
      const { journal, trunks, pool, layer } = bootstrap();
      return Effect.gen(function* () {
        const head = yield* seedSource;
        const project = yield* bootstrapped(creating());
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
    "[run.own-project] an agent's project is created as the agent and in its run: the event's actor, its run and its `by`, and a replay answers the same project",
    () => {
      const { layer } = bootstrap();
      const agentId = Schema.decodeUnknownSync(AgentId)("agt_01M4A00000000000000000000A");
      const run = Schema.decodeUnknownSync(RunRef)({
        id: "run_01M4R00000000000000000000A",
        label: "run-c",
      });
      const byAgent = { ...creating(), by: agentId, actor: agentActor(agentId) };
      return Effect.gen(function* () {
        yield* seedSource;
        const project = yield* bootstrapped({ ...byAgent, run });
        const [created, ...others] = (yield* EventOutbox).log({ kind: "project", id: projectId });
        expect(created).toMatchObject({
          actor: `agent:${agentId}`,
          run,
          payload: { _tag: "ProjectCreated", by: agentId },
        });
        expect(others).toEqual([]);
        expect(yield* bootstrapped({ ...byAgent, run })).toEqual(project);
        expect((yield* EventOutbox).log({ kind: "project", id: projectId })).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[run.own-project] a creation in no run names none: a person's, and an agent's whose token named no run",
    () => {
      const { layer } = bootstrap();
      const agentId = Schema.decodeUnknownSync(AgentId)("agt_01M4A00000000000000000000A");
      return Effect.gen(function* () {
        yield* seedSource;
        yield* bootstrapped({ ...creating(), by: agentId, actor: agentActor(agentId) });
        const [created] = (yield* EventOutbox).log({ kind: "project", id: projectId });
        expect(created).toMatchObject({ actor: `agent:${agentId}`, payload: { by: agentId } });
        expect(created).not.toHaveProperty("run");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[b11.bootstrap-replay] answers a replay of the key from what it committed, touching nothing",
    () => {
      const { journal, layer } = bootstrap();
      return Effect.gen(function* () {
        yield* seedSource;
        const first = yield* bootstrapped(creating());
        const calls = journal.length;
        const replayed = yield* bootstrapped(creating());
        const reused = yield* Effect.exit(bootstrapped(creating("create-1", "body-2")));

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
        const crashed = yield* Effect.exit(bootstrapped(creating()));
        const configuredAfterCrash = pool.configured.size;
        const project = yield* bootstrapped(creating());
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
        bootstrapped(starting({ _tag: "Template", repo: "no-such-repo" })),
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
        const head = yield* parentProject(trunks);
        yield* forking;
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
    "[create.fork-relays] a fork's trunk is created empty and takes the source trunk's history once, through its own writer: the code host is never asked to fork the source, and trunk starts at the source's head",
    () => {
      const { journal, hostCalls, trunks, takesAsked, layer } = bootstrap();
      return Effect.gen(function* () {
        const head = yield* parentProject(trunks);
        hostCalls.length = 0;
        yield* forking;
        const repos = projectRepos(projectId);
        // Staging is still a fork of trunk: it is only ever asked past a have.
        expect(hostCalls).toEqual([
          `create ${nameOf(repos.trunk)}`,
          `fork ${nameOf(repos.trunk)} as ${nameOf(repos.staging)}`,
          `create ${nameOf(repos.mirror)}`,
        ]);
        expect(takesAsked).toEqual([parentId]);
        expect(trunks.taken.get(projectId)).toBe(parentId);
        expect(journal).toEqual([
          `take ${projectId}`,
          `initialize ${projectId}`,
          `sync ${projectId}`,
          `configure ${projectId}`,
        ]);
        const host = yield* CodeHost;
        expect(yield* host.head(repos.trunk, MAIN)).toBe(head);
        expect(yield* host.head(repos.staging, MAIN)).toBe(head);
        expect(trunks.heads.get(projectId)).toBe(head);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[create.fork-retry] a retry after trunk's repo was made and before its history came takes it then; a retry after it came takes nothing, and trunk stays where it started though the source has moved on",
    () => {
      const { hostCalls, trunks, takesAsked, layer } = bootstrap({
        loseTakeOnce: true,
        failSyncOnce: true,
      });
      return Effect.gen(function* () {
        const head = yield* parentProject(trunks);
        const repos = projectRepos(projectId);
        const host = yield* CodeHost;
        // The relay is lost: trunk's repo is there, with no main.
        const lost = yield* Effect.exit(forking);
        expect(Exit.isFailure(lost)).toBe(true);
        expect(yield* held(repos.trunk)).toBe(true);
        expect(yield* host.branches(repos.trunk)).toEqual([]);
        // The retry makes no second repo and takes the history; then its sync crashes.
        hostCalls.length = 0;
        const crashed = yield* Effect.exit(forking);
        expect(Exit.isFailure(crashed)).toBe(true);
        expect(takesAsked).toEqual([parentId, parentId]);
        expect(hostCalls).not.toContain(`create ${nameOf(repos.trunk)}`);
        expect(yield* host.head(repos.trunk, MAIN)).toBe(head);
        // The source moves on: the next retry takes nothing, and the fork starts where it first did.
        const later = yield* (yield* CodeHostFixture).commit(projectRepos(parentId).trunk, MAIN, {
          "README.md": "parent, later",
        });
        trunks.heads.set(parentId, later);
        const project = yield* forking;
        expect(project.id).toBe(projectId);
        expect(takesAsked).toEqual([parentId, parentId]);
        expect(yield* host.head(repos.trunk, MAIN)).toBe(head);
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
    "[create.fork-refused] a fork of a project over what one relay carries is refused as an import of that size is, and one of a project that is gone as the host said it: the empty trunk is deleted, and there is no staging, no mirror, no trunk, no pool and no project",
    () => {
      const { journal, hostCalls, trunks, pool, layer } = bootstrap();
      return Effect.gen(function* () {
        yield* parentProject(trunks);
        trunks.outgrow(parentId);
        const repos = projectRepos(projectId);
        const tooLarge = yield* Effect.flip(forking);
        expect(tooLarge).toEqual(
          new ImportTooLarge({
            projectId,
            bytes: RELAY_PACK_CAP_BYTES + 1,
            limit: RELAY_PACK_CAP_BYTES,
          }),
        );
        const gone = yield* Effect.flip(createProjectOf({ _tag: "Project", projectId: goneId }));
        expect(gone).toMatchObject({ _tag: "RepoNotFound", repo: projectRepos(goneId).trunk });
        expect(hostCalls.filter((call) => call.endsWith(nameOf(repos.trunk)))).toEqual([
          `create ${nameOf(repos.trunk)}`,
          `delete ${nameOf(repos.trunk)}`,
          `create ${nameOf(repos.trunk)}`,
          `delete ${nameOf(repos.trunk)}`,
        ]);
        expect([
          yield* held(repos.trunk),
          yield* held(repos.staging),
          yield* held(repos.mirror),
        ]).toEqual([false, false, false]);
        expect(trunks.heads.has(projectId)).toBe(false);
        expect(journal).toEqual([]);
        expect(pool.configured.size).toBe(0);
        expect(yield* projectEvents).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.start-empty] an empty project's trunk is created and seeded once, with the project's name at the time its bootstrap began, and initialized at that commit with an empty origin; a retry after a crash asks for no second seed",
    () => {
      const { journal, clock, trunks, seedsAsked, layer } = bootstrap({ failSyncOnce: true });
      return Effect.gen(function* () {
        const began = clock.now();
        const crashed = yield* Effect.exit(bootstrapped(starting({ _tag: "Empty" })));
        expect(Exit.isFailure(crashed)).toBe(true);
        clock.advance(60_000);
        const project = yield* bootstrapped(starting({ _tag: "Empty" }));
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
        const lost = yield* Effect.exit(bootstrapped(starting({ _tag: "Empty" })));
        expect(Exit.isFailure(lost)).toBe(true);
        clock.advance(60_000);
        yield* bootstrapped(starting({ _tag: "Empty" }));
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
        const crashed = yield* Effect.exit(bootstrapped(starting(source)));
        expect(Exit.isFailure(crashed)).toBe(true);
        yield* bootstrapped(starting(source));
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
        yield* bootstrapped(
          starting({ _tag: "Import", url: upstream.url, ref: upstream.other.name }),
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
          yield* bootstrapped(starting({ _tag: "Import", url: "https://git.example/team/app" }));
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
          (source) => Effect.flip(bootstrapped(starting(source))),
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
            bootstrapped(starting({ _tag: "Import", url: upstream.url })),
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

describe("a project's finish", () => {
  it.effect(
    "[project.answers-at-trunk] a create answers once trunk is initialized, with ProjectCreated and no staging, mirror or pool yet; the finish then makes them, each once, and a second finish makes nothing",
    () => {
      const { journal, pool, layer } = bootstrap();
      return Effect.gen(function* () {
        const head = yield* seedSource;
        const repos = projectRepos(projectId);
        const project = yield* createProject(creating());
        expect(project).toMatchObject({ id: projectId, name: "Seed app" });
        expect(yield* projectEvents).toEqual(["ProjectCreated"]);
        expect(yield* (yield* CodeHost).head(repos.trunk, MAIN)).toBe(head);
        expect([yield* held(repos.staging), yield* held(repos.mirror)]).toEqual([false, false]);
        expect(pool.configured.get(projectId)).toBeUndefined();
        expect(journal).toEqual([`initialize ${projectId}`]);

        expect(yield* finishProject(projectId, POOL_TARGET)).toBe("finished");
        expect(yield* (yield* CodeHost).head(repos.staging, MAIN)).toBe(head);
        expect(yield* held(repos.mirror)).toBe(true);
        expect(pool.configured.get(projectId)).toEqual({
          source: repos.mirror,
          target: POOL_TARGET,
        });
        expect(finishOf(yield* EntityStore, projectId)).toEqual({
          done: ["staging", "mirror", "sync", "pool"],
        });
        expect(yield* finishProject(projectId, POOL_TARGET)).toBe("finished");
        expect(journal).toEqual([
          `initialize ${projectId}`,
          `sync ${projectId}`,
          `configure ${projectId}`,
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.finishes-behind] a failing step fails the pass and stays the next to make: its failures are counted in a row, the pool is told when the next try comes, and the next pass makes only what is left",
    () => {
      const { journal, pool, layer } = bootstrap({ failSyncOnce: true });
      return Effect.gen(function* () {
        yield* seedSource;
        const repos = projectRepos(projectId);
        yield* createProject(creating());
        const failed = yield* Effect.exit(finishProject(projectId, POOL_TARGET));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(finishOf(yield* EntityStore, projectId).done).toEqual(["staging", "mirror"]);
        expect(yield* finishFailed(projectId)).toMatchObject({ step: "sync", times: 1 });
        expect(yield* finishFailed(projectId)).toMatchObject({ step: "sync", times: 2 });
        const nextTry = Instant(1_700_000_120_000);
        yield* holdPool(projectId, nextTry);
        expect(pool.configured.get(projectId)).toEqual({
          source: repos.mirror,
          target: 0,
          readyAt: nextTry,
        });

        expect(yield* finishProject(projectId, POOL_TARGET)).toBe("finished");
        // The memory trunks journal a sync once it succeeds: the failed one is not there.
        expect(journal.filter((line) => line.startsWith("sync"))).toHaveLength(1);
        expect(pool.configured.get(projectId)).toEqual({
          source: repos.mirror,
          target: POOL_TARGET,
        });
        // Once the pool is configured nothing more is told, and a finished finish counts no failure.
        yield* holdPool(projectId, nextTry);
        expect(pool.configured.get(projectId)).toEqual({
          source: repos.mirror,
          target: POOL_TARGET,
        });
        expect(yield* finishFailed(projectId)).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.finish-backoff] a step failing again and again waits twice as long each time up to five minutes, is a defect from its fifth failure in a row, and the next step to fail starts again at one",
    () => {
      const { layer } = bootstrap({ failMirrorTimes: 10, failSyncOnce: true });
      return Effect.gen(function* () {
        yield* seedSource;
        yield* createProject(creating());
        const retries = [];
        for (let pass = 0; pass < 10; pass += 1) {
          expect(Exit.isFailure(yield* Effect.exit(finishProject(projectId, POOL_TARGET)))).toBe(
            true,
          );
          retries.push(yield* finishFailed(projectId));
        }
        expect(retries.map((retry) => [retry?.step, retry?.times])).toEqual(
          Array.from({ length: 10 }, (_, n) => ["mirror", n + 1]),
        );
        expect(retries.map((retry) => retry?.delayMs)).toEqual([
          1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000,
        ]);
        expect(retries.map((retry) => retry?.defect)).toEqual([
          false,
          false,
          false,
          false,
          true,
          true,
          true,
          true,
          true,
          true,
        ]);

        expect(Exit.isFailure(yield* Effect.exit(finishProject(projectId, POOL_TARGET)))).toBe(
          true,
        );
        expect(yield* finishFailed(projectId)).toEqual({
          step: "sync",
          times: 1,
          delayMs: 1_000,
          defect: false,
        });
        expect(yield* finishProject(projectId, POOL_TARGET)).toBe("finished");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.finishes-behind] a project that was never created is not finished, and a deleted one is finished no further: nothing more is made",
    () => {
      const { journal, layer } = bootstrap();
      return Effect.gen(function* () {
        yield* seedSource;
        const repos = projectRepos(projectId);
        expect(yield* finishProject(projectId, POOL_TARGET)).toBe("absent");
        expect(yield* held(repos.staging)).toBe(false);

        yield* createProject(creating());
        yield* commit({ entity: { kind: "project", id: projectId }, cause: "delete" }, () =>
          Result.succeed({
            value: undefined,
            drafts: [{ payload: { _tag: "ProjectDeleted", projectId, by: creator } }],
          }),
        );
        expect(yield* finishProject(projectId, POOL_TARGET)).toBe("deleted");
        expect([yield* held(repos.staging), yield* held(repos.mirror)]).toEqual([false, false]);
        expect(journal).toEqual([`initialize ${projectId}`]);
      }).pipe(Effect.provide(layer));
    },
  );
});
