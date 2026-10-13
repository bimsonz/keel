import { describe, expect, it } from "@effect/vitest";
import { createProject, projectIdFor } from "@keeltown/core/application/coordination";
import { createProject as bootstrap, projectRepos } from "@keeltown/core/application/integration";
import { type Actor, actorId, eventActorOf } from "@keeltown/core/domain/identity";
import { isId, NamespaceId, type ProjectId, UserId } from "@keeltown/core/kernel";
import {
  type Clock,
  CodeHost,
  type EntityStore,
  EventOutbox,
  OrgUsage,
  ProjectNamespaces,
  type ProjectPlace,
  Projects,
  Trunks,
  type WorkspacePool,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeOrgUsageMemory,
  makeManualClock,
  makeProjectNamespacesMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Option, Schema } from "effect";

const ORG = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const ELSEWHERE = Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V7");
const user = (id: string): Actor => ({
  _tag: "User",
  userId: Schema.decodeUnknownSync(UserId)(id),
});
const alice = user("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const bob = user("usr_01JZ8PT2C4E6G8J0M2N4Q6S8V9");
const SOURCE = { namespace: "keel-core", name: "seed-app" };

/**
 * A project's creation end to end in memory: its places, and `Projects` over
 * the Project DO's own bootstrap, whose Trunk notes the place it sees as it is
 * initialized. `journal` orders the place's assignment against the DO's steps.
 * `failSyncOnce` crashes the first bootstrap after trunk is initialized.
 */
function world(options: { readonly failSyncOnce?: boolean } = {}) {
  const journal: string[] = [];
  const places = makeProjectNamespacesMemory();
  const seen = new Map<ProjectId, Option.Option<ProjectPlace>>();
  const code = makeCodeHostMemory();
  const outbox = makeEventOutboxMemory();
  const placed = Layer.effect(
    ProjectNamespaces,
    Effect.map(ProjectNamespaces, (inner) =>
      ProjectNamespaces.of({
        ...inner,
        assign: (place, room) =>
          Effect.tap(inner.assign(place, room), () =>
            Effect.sync(() => journal.push(`assign ${place.projectId}`)),
          ),
      }),
    ),
  ).pipe(Layer.provide(places.layer));
  const trunks = Layer.effect(
    Trunks,
    Effect.gen(function* () {
      const inner = yield* Trunks;
      const orgs = yield* ProjectNamespaces;
      return Trunks.of({
        ...inner,
        initialize: (projectId, head, by, origin) =>
          Effect.flatMap(orgs.byId(projectId), (place) => {
            seen.set(projectId, place);
            return inner.initialize(projectId, head, by, origin);
          }),
      });
    }),
  ).pipe(Layer.provide([makeTrunksMemory({ journal, ...options }).layer, places.layer]));
  const projectObject = Layer.effect(
    Projects,
    Effect.gen(function* () {
      const services = yield* Effect.context<
        Clock | EntityStore | EventOutbox | CodeHost | Trunks | WorkspacePool
      >();
      return Projects.of({
        create: (actor, input) =>
          Effect.provide(
            bootstrap(
              {
                ...input,
                by: actorId(actor),
                actor: eventActorOf(actor),
                fingerprint: JSON.stringify([input.name, input.source]),
              },
              2,
            ),
            services,
          ),
        settings: (projectId) => Effect.die(`settings of ${projectId} is not asked here`),
        putSettings: (_actor, projectId) =>
          Effect.die(`putSettings of ${projectId} is not asked here`),
        liveAnchors: (projectId) => Effect.die(`liveAnchors of ${projectId} is not asked here`),
      });
    }),
  ).pipe(
    Layer.provide([
      outbox.layer,
      makeManualClock().layer,
      code.layer,
      trunks,
      makeWorkspacePoolMemory({ journal }).layer,
    ]),
  );
  const usage = makeOrgUsageMemory();
  const layer = Layer.mergeAll(
    projectObject,
    placed,
    code.layer,
    outbox.layer,
    usage.layer,
    usage.clock.layer,
  );
  return { journal, places, seen, layer };
}

const seedSource = Effect.gen(function* () {
  yield* (yield* CodeHost).create(SOURCE);
  yield* (yield* CodeHostFixture).commit(SOURCE, "refs/heads/main", { "README.md": "seed" });
});

const TEMPLATE = { _tag: "Template", repo: SOURCE.name } as const;

const creating = (actor: Actor, name: string, idempotencyKey: string) =>
  createProject(actor, { namespace: ORG, name, source: TEMPLATE, idempotencyKey });

/** The head of a project's trunk on the code host. */
const trunkHead = (projectId: ProjectId) =>
  CodeHost.use((host) => host.head(projectRepos(projectId).trunk, "refs/heads/main"));

const created = (projectId: ProjectId) =>
  Effect.map(EventOutbox, (outbox) =>
    outbox.log({ kind: "project", id: projectId }).filter((e) => e.type === "ProjectCreated"),
  );

describe("createProject", () => {
  it.effect(
    "[project.create-heals] places the project before its Project DO is made, so the Trunk's initialize sees the place",
    () => {
      const { journal, seen, layer } = world();
      return Effect.gen(function* () {
        yield* seedSource;
        const project = yield* creating(alice, "Seed-App", "create-1");
        const id = projectIdFor(alice, "create-1");
        expect(project).toMatchObject({ id, name: "seed-app" });
        expect(journal).toEqual([
          `assign ${id}`,
          `initialize ${id}`,
          `sync ${id}`,
          `configure ${id}`,
        ]);
        expect(seen.get(id)).toEqual(
          Option.some({ projectId: id, namespace: ORG, name: "seed-app" }),
        );
        expect(yield* created(id)).toMatchObject([{ actor: `user:${actorId(alice)}` }]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.create-heals] a retry with the same key finishes a project whose Project DO failed after its place was taken: one project, one id",
    () => {
      const { places, layer } = world({ failSyncOnce: true });
      return Effect.gen(function* () {
        yield* seedSource;
        const id = projectIdFor(alice, "create-1");
        const crashed = yield* Effect.exit(creating(alice, "forge", "create-1"));
        expect(Exit.isFailure(crashed)).toBe(true);
        expect(places.places.get(id)).toEqual({ projectId: id, namespace: ORG, name: "forge" });
        expect(yield* created(id)).toEqual([]);

        const healed = yield* creating(alice, "forge", "create-1");
        expect(healed.id).toBe(id);
        expect(yield* creating(alice, "forge", "create-1")).toEqual(healed);
        expect([...places.places.values()]).toEqual([
          { projectId: id, namespace: ORG, name: "forge" },
        ]);
        expect(yield* created(id)).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.create-heals] another key for a name the org holds is ProjectNameTaken, in any case, and reaches no Project DO",
    () => {
      const { journal, places, layer } = world();
      return Effect.gen(function* () {
        yield* seedSource;
        yield* creating(alice, "forge", "create-1");
        const steps = journal.length;
        for (const [actor, key] of [
          [alice, "create-2"],
          [bob, "create-1"],
        ] as const) {
          const taken = yield* Effect.flip(creating(actor, "FORGE", key));
          expect(taken).toMatchObject({ _tag: "ProjectNameTaken", namespace: ORG, name: "forge" });
        }
        expect(journal).toHaveLength(steps);
        expect(places.places.size).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[project.place-released] a start the Project DO refuses gives the project's place back, so its name is free for the next try under another key; a key reused for another body gives nothing back",
    () => {
      const { places, layer } = world();
      const nowhere = { _tag: "Import", url: "https://git.memory.test/upstream/none" } as const;
      return Effect.gen(function* () {
        yield* seedSource;
        const refused = yield* Effect.flip(
          createProject(alice, {
            namespace: ORG,
            name: "forge",
            source: nowhere,
            idempotencyKey: "create-1",
          }),
        );
        expect(refused).toMatchObject({ _tag: "ImportRefused", reason: "not-found" });
        expect(places.places.size).toBe(0);

        const project = yield* creating(alice, "forge", "create-2");
        expect(places.places.get(project.id)).toMatchObject({ namespace: ORG, name: "forge" });
        const reused = yield* Effect.flip(
          createProject(alice, {
            namespace: ORG,
            name: "forge",
            source: nowhere,
            idempotencyKey: "create-2",
          }),
        );
        expect(reused).toMatchObject({ _tag: "IdempotencyConflict" });
        expect(places.places.get(project.id)).toMatchObject({ namespace: ORG, name: "forge" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[projects.quota] a namespace's eleventh project is QuotaExceeded of kind projects, naming the ten it holds, and reaches no Project DO; another namespace has room of its own, and one already made is itself again",
    () => {
      const { journal, places, layer } = world();
      return Effect.gen(function* () {
        yield* seedSource;
        for (let n = 1; n <= 10; n += 1) yield* creating(alice, `app-${n}`, `create-${n}`);
        const steps = journal.length;
        const over = yield* Effect.flip(creating(alice, "app-11", "create-11"));
        expect(over).toMatchObject({
          _tag: "QuotaExceeded",
          kind: "projects",
          reason: "limit",
          limit: 10,
          used: 10,
          requested: 1,
        });
        expect(journal).toHaveLength(steps);
        expect(places.places.size).toBe(10);
        expect(places.places.has(projectIdFor(alice, "create-11"))).toBe(false);

        const elsewhere = yield* createProject(alice, {
          namespace: ELSEWHERE,
          name: "app-11",
          source: TEMPLATE,
          idempotencyKey: "create-12",
        });
        expect(places.places.get(elsewhere.id)).toMatchObject({ namespace: ELSEWHERE });
        expect((yield* creating(alice, "app-3", "create-3")).id).toBe(
          projectIdFor(alice, "create-3"),
        );
        expect(places.places.size).toBe(11);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[projects.quota-own-limit] a namespace's own limit comes before the instance's: one set to two refuses its third, and set to twelve it is given its eleventh and twelfth",
    () => {
      const { layer } = world();
      return Effect.gen(function* () {
        yield* seedSource;
        const usage = yield* OrgUsage;
        yield* usage.configure(ORG, { overrides: { projects: 2 }, halted: false });
        yield* creating(alice, "app-1", "create-1");
        yield* creating(alice, "app-2", "create-2");
        expect(yield* Effect.flip(creating(alice, "app-3", "create-3"))).toMatchObject({
          _tag: "QuotaExceeded",
          kind: "projects",
          limit: 2,
          used: 2,
        });
        yield* usage.configure(ORG, { overrides: { projects: 12 }, halted: false });
        for (let n = 3; n <= 12; n += 1) yield* creating(alice, `app-${n}`, `again-${n}`);
        expect(yield* Effect.flip(creating(alice, "app-13", "again-13"))).toMatchObject({
          _tag: "QuotaExceeded",
          kind: "projects",
          limit: 12,
          used: 12,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[projects.quota-room-back] a start the Project DO refuses takes none of the namespace's room: at nine, the tenth is still made after one, and the eleventh is refused",
    () => {
      const { places, layer } = world();
      const nowhere = { _tag: "Import", url: "https://git.memory.test/upstream/none" } as const;
      return Effect.gen(function* () {
        yield* seedSource;
        for (let n = 1; n <= 9; n += 1) yield* creating(alice, `app-${n}`, `create-${n}`);
        const refused = yield* Effect.flip(
          createProject(alice, {
            namespace: ORG,
            name: "app-10",
            source: nowhere,
            idempotencyKey: "create-none",
          }),
        );
        expect(refused).toMatchObject({ _tag: "ImportRefused" });
        expect(places.places.size).toBe(9);
        yield* creating(alice, "app-ten", "create-10");
        expect(yield* Effect.flip(creating(alice, "app-11", "create-11"))).toMatchObject({
          _tag: "QuotaExceeded",
          used: 10,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("refuses the key reused for another name or org as IdempotencyConflict", () => {
    const { journal, layer } = world();
    return Effect.gen(function* () {
      yield* seedSource;
      yield* creating(alice, "forge", "create-1");
      const steps = journal.length;
      const renamed = yield* Effect.flip(creating(alice, "anvil", "create-1"));
      expect(renamed).toMatchObject({ _tag: "IdempotencyConflict", idempotencyKey: "create-1" });
      const moved = yield* Effect.flip(
        createProject(alice, {
          namespace: Schema.decodeUnknownSync(NamespaceId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V1"),
          name: "forge",
          source: TEMPLATE,
          idempotencyKey: "create-1",
        }),
      );
      expect(moved).toMatchObject({ _tag: "IdempotencyConflict" });
      expect(journal).toHaveLength(steps);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "[project.source-fork] a project as the source forks that project's trunk, at the head it has by then",
    () => {
      const { layer } = world();
      return Effect.gen(function* () {
        yield* seedSource;
        const first = yield* creating(alice, "forge", "create-1");
        const moved = yield* (yield* CodeHostFixture).commit(
          projectRepos(first.id).trunk,
          "refs/heads/main",
          { "PLAN.md": "ours" },
        );
        const fork = yield* createProject(bob, {
          namespace: ORG,
          name: "anvil",
          source: { _tag: "Project", projectId: first.id },
          idempotencyKey: "create-1",
        });
        const fromTemplate = yield* creating(bob, "tongs", "create-2");
        expect(yield* trunkHead(fork.id)).toBe(moved);
        expect(yield* trunkHead(fromTemplate.id)).not.toBe(moved);
      }).pipe(Effect.provide(layer));
    },
  );

  it("[a11b.derive] derives one project id per actor and key", () => {
    const id = projectIdFor(alice, "create-1");
    expect(isId("prj", id)).toBe(true);
    expect(projectIdFor(alice, "create-1")).toBe(id);
    expect(projectIdFor(alice, "create-2")).not.toBe(id);
    expect(projectIdFor(bob, "create-1")).not.toBe(id);
  });
});
