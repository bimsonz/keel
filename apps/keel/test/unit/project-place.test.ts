import { describe, expect, it } from "@effect/vitest";
import { createProject, projectIdFor } from "@keeltown/core/application/coordination";
import { createProject as bootstrap, projectRepos } from "@keeltown/core/application/integration";
import { type Actor, actorId } from "@keeltown/core/domain/identity";
import { isId, OrgId, type ProjectId, UserId } from "@keeltown/core/kernel";
import {
  type Clock,
  CodeHost,
  type EntityStore,
  EventOutbox,
  ProjectOrgs,
  type ProjectPlace,
  Projects,
  Trunks,
  type WorkspacePool,
} from "@keeltown/core/ports";
import {
  CodeHostFixture,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeManualClock,
  makeProjectOrgsMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Option, Schema } from "effect";

const ORG = Schema.decodeUnknownSync(OrgId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
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
  const places = makeProjectOrgsMemory();
  const seen = new Map<ProjectId, Option.Option<ProjectPlace>>();
  const code = makeCodeHostMemory();
  const outbox = makeEventOutboxMemory();
  const placed = Layer.effect(
    ProjectOrgs,
    Effect.map(ProjectOrgs, (inner) =>
      ProjectOrgs.of({
        ...inner,
        assign: (place) =>
          Effect.tap(inner.assign(place), () =>
            Effect.sync(() => journal.push(`assign ${place.projectId}`)),
          ),
      }),
    ),
  ).pipe(Layer.provide(places.layer));
  const trunks = Layer.effect(
    Trunks,
    Effect.gen(function* () {
      const inner = yield* Trunks;
      const orgs = yield* ProjectOrgs;
      return Trunks.of({
        ...inner,
        initialize: (projectId, head, by) =>
          Effect.flatMap(orgs.byId(projectId), (place) => {
            seen.set(projectId, place);
            return inner.initialize(projectId, head, by);
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
  const layer = Layer.mergeAll(projectObject, placed, code.layer, outbox.layer);
  return { journal, places, seen, layer };
}

const seedSource = Effect.gen(function* () {
  yield* (yield* CodeHost).create(SOURCE);
  yield* (yield* CodeHostFixture).commit(SOURCE, "refs/heads/main", { "README.md": "seed" });
});

const TEMPLATE = { _tag: "Template", repo: SOURCE.name } as const;

const creating = (actor: Actor, name: string, idempotencyKey: string) =>
  createProject(actor, { org: ORG, name, source: TEMPLATE, idempotencyKey });

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
        expect(seen.get(id)).toEqual(Option.some({ projectId: id, org: ORG, name: "seed-app" }));
        expect(yield* created(id)).toMatchObject([{ actor: `operator:${actorId(alice)}` }]);
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
        expect(places.places.get(id)).toEqual({ projectId: id, org: ORG, name: "forge" });
        expect(yield* created(id)).toEqual([]);

        const healed = yield* creating(alice, "forge", "create-1");
        expect(healed.id).toBe(id);
        expect(yield* creating(alice, "forge", "create-1")).toEqual(healed);
        expect([...places.places.values()]).toEqual([{ projectId: id, org: ORG, name: "forge" }]);
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
          expect(taken).toMatchObject({ _tag: "ProjectNameTaken", org: ORG, name: "forge" });
        }
        expect(journal).toHaveLength(steps);
        expect(places.places.size).toBe(1);
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
          org: Schema.decodeUnknownSync(OrgId)("org_01JZ8PT2C4E6G8J0M2N4Q6S8V1"),
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
          org: ORG,
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
