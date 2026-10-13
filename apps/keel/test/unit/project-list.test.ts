import { describe, expect, it } from "@effect/vitest";
import {
  noteVisibility,
  repairVisibility,
  VISIBILITY_PENDING,
  visibilityOf,
} from "@keeltown/core/application/integration";
import {
  type AgentStanding,
  Handle,
  personOwns,
  type Principal,
  projectAudience,
  type Role,
  type Scope,
  type Visibility,
} from "@keeltown/core/domain/identity";
import {
  EventEnvelope,
  makeId,
  type NamespaceId,
  namespaceKind,
  type ProjectId,
} from "@keeltown/core/kernel";
import { EntityStore, ProjectNamespaces } from "@keeltown/core/ports";
import {
  makeBetterAuthMemory,
  makeEntityStoreMemory,
  makeProjectNamespacesMemory,
} from "@keeltown/testing";
import { Effect, Layer, Result, Schema } from "effect";
import * as fc from "fast-check";
import { decideEach } from "../../src/adapters/driving/http/authorize-handlers.ts";
import { listProjects } from "../../src/adapters/driving/http/project-list.ts";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
const runs = { numRuns: 300, ...(seed === undefined ? {} : { seed: Number(seed) }) };

const ulidOf = (n: number) => `01JZ8PT2C4E6G8J0M2N4Q6${n.toString().padStart(4, "0")}`;
const USERS = [
  makeId("usr", ulidOf(0)),
  makeId("usr", ulidOf(1)),
  makeId("usr", ulidOf(2)),
] as const;
const ORGS = [
  makeId("org", ulidOf(0)),
  makeId("org", ulidOf(1)),
  makeId("org", ulidOf(2)),
] as const;
const NAMESPACES = [...USERS, ...ORGS] as const;
/** The `i`th of a list that has a first, wrapping. */
const at = <T>(list: readonly [T, ...T[]], i: number): T => list[i % list.length] ?? list[0];
const ROLES: readonly Role[] = ["member", "maintainer", "owner"];

/** A drawn instance: which namespaces are suspended, each project's namespace and visibility, and who asks. */
const world = fc.record({
  held: fc.array(fc.constantFrom(false, false, false, true), { minLength: 6, maxLength: 6 }),
  projects: fc.array(
    fc.record({ in: fc.nat(5), visibility: fc.constantFrom<Visibility>("private", "public") }),
    { maxLength: 14 },
  ),
  asker: fc.oneof(
    fc.constant({ kind: "visitor" as const }),
    fc.record({
      kind: fc.constant("user" as const),
      who: fc.nat(2),
      handled: fc.boolean(),
      suspended: fc.boolean(),
      roles: fc.array(fc.option(fc.constantFrom(...ROLES), { nil: undefined }), {
        minLength: 3,
        maxLength: 3,
      }),
    }),
    fc.record({
      kind: fc.constant("agent" as const),
      project: fc.option(fc.nat(13), { nil: undefined }),
      // Most tokens are for the namespace of the project they name: the one place an agent reads what is private.
      in: fc.oneof(
        { weight: 4, arbitrary: fc.constant(undefined) },
        { weight: 1, arbitrary: fc.nat(5) },
      ),
      paused: fc.constantFrom(false, false, false, true),
      reads: fc.constantFrom(true, true, true, false),
      standing: fc.constantFrom<AgentStanding>(
        { _tag: "Governs" },
        { _tag: "Governs" },
        { _tag: "None" },
        { _tag: "Invited", by: { userId: USERS[0], role: "member", suspended: false } },
        { _tag: "Invited", by: { userId: USERS[0], suspended: false } },
      ),
    }),
  ),
  limit: fc.integer({ min: 1, max: 5 }),
});

type World = typeof world extends fc.Arbitrary<infer W> ? W : never;

const namespaceAt = (i: number): NamespaceId => at(NAMESPACES, i);

/** The drawn asker as the gate would build it, over the drawn projects' ids. */
function principalOf(
  asker: World["asker"],
  projects: readonly { readonly projectId: ProjectId; readonly namespace: NamespaceId }[],
): Principal {
  if (asker.kind === "visitor") return { _tag: "Anonymous" };
  if (asker.kind === "user")
    return {
      _tag: "User",
      userId: at(USERS, asker.who),
      ...(asker.handled ? { handle: Schema.decodeUnknownSync(Handle)("ada") } : {}),
      suspended: asker.suspended,
      memberships: asker.roles.flatMap((role, i) =>
        role === undefined ? [] : [{ org: at(ORGS, i), role }],
      ),
    };
  const project =
    asker.project === undefined ? undefined : projects[asker.project % (projects.length || 1)];
  const scopes: readonly Scope[] = asker.reads ? ["agent:read", "agent:work"] : ["agent:work"];
  return {
    _tag: "Agent",
    agentId: makeId("agt", ulidOf(0)),
    namespace:
      asker.in === undefined ? (project?.namespace ?? namespaceAt(0)) : namespaceAt(asker.in),
    ...(project === undefined ? {} : { projectId: project.projectId }),
    scopes,
    paused: asker.paused,
    standing: asker.standing,
  };
}

describe("the list of projects", () => {
  it("[projects.list-narrowed] is the policy applied to every project on the instance, whoever asks and whatever the page size", async () => {
    await fc.assert(
      fc.asyncProperty(world, (drawn) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const rows = makeBetterAuthMemory({
              users: USERS.map((id, i) => ({
                id,
                username: `user-${i}`,
                banned: drawn.held[i] === true,
              })),
              orgs: ORGS.map((id, i) => ({
                id,
                slug: `org-${i}`,
                suspended: drawn.held[i + 3] === true,
              })),
            });
            const memory = makeProjectNamespacesMemory(rows);
            const projects = drawn.projects.map((project, i) => ({
              projectId: makeId("prj", ulidOf(i)),
              namespace: namespaceAt(project.in),
              held: drawn.held[project.in % NAMESPACES.length] === true,
              visibility: project.visibility,
            }));
            const principal = principalOf(drawn.asker, projects);
            const listed = yield* Effect.gen(function* () {
              const places = yield* ProjectNamespaces;
              for (const project of projects) {
                yield* places.assign({ ...project, name: project.projectId });
                yield* places.visibility(project.projectId, project.visibility, 1);
              }
              const ids: ProjectId[] = [];
              let cursor: ProjectId | undefined;
              do {
                const page = yield* listProjects(principal, cursor, drawn.limit);
                expect(page.items.length).toBeLessThanOrEqual(drawn.limit);
                ids.push(...page.items.map((row) => row.projectId));
                cursor = page.nextCursor;
              } while (cursor !== undefined);
              return ids;
            }).pipe(Effect.provide(memory.layer));

            const granted = projects
              .filter((project) =>
                Result.isSuccess(
                  decideEach(principal, {
                    _tag: "Project",
                    namespace: project.namespace,
                    projectId: project.projectId,
                    visibility: project.visibility,
                    namespaceSuspended: project.held,
                    personOwned: personOwns(namespaceKind(project.namespace)),
                  }),
                ),
              )
              .map((project) => project.projectId);
            expect(listed).toEqual(granted);
          }),
        ),
      ),
      runs,
    );
  });

  it("[projects.audience] a person's audience is their own namespace and their orgs, an agent's its token's project, a visitor's nothing", () => {
    const [ada] = USERS;
    const [acme, globex] = ORGS;
    const prj = makeId("prj", ulidOf(7));
    expect(
      projectAudience({
        _tag: "User",
        userId: ada,
        suspended: false,
        memberships: [
          { org: acme, role: "member" },
          { org: globex, role: "owner" },
        ],
      }),
    ).toEqual({ namespaces: [ada, acme, globex] });
    const agent = {
      _tag: "Agent" as const,
      agentId: makeId("agt", ulidOf(0)),
      namespace: acme,
      scopes: [],
      paused: false,
      standing: { _tag: "Governs" as const },
    };
    expect(projectAudience({ ...agent, projectId: prj })).toEqual({ namespaces: [], project: prj });
    expect(projectAudience(agent)).toEqual({ namespaces: [] });
    expect(projectAudience({ _tag: "Anonymous" })).toEqual({ namespaces: [] });
  });
});

const PRJ = makeId("prj", ulidOf(42));

/** A settings event of the project at `seq`, changing `changes`. */
const settings = (
  seq: number,
  changes: readonly { readonly field: string; readonly from: unknown; readonly to: unknown }[],
  type = "ProjectSettingsChanged",
) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type,
    entity: { kind: "project", id: PRJ },
    seq,
    at: 1_760_000_000_000 + seq,
    dedupeKey: `project:${PRJ}/${seq}/${type}#1`,
    affected: [],
    notified: [],
    project: PRJ,
    payload: { _tag: type, projectId: PRJ, changes, by: USERS[0] },
  });

const shown = (seq: number, to: Visibility) =>
  settings(seq, [{ field: "visibility", from: to === "public" ? "private" : "public", to }]);

/** Notes each event as the Projector's receipt does, in one transaction. */
const note = (...events: readonly EventEnvelope[]) =>
  EntityStore.use((store) =>
    Effect.sync(() =>
      store.transaction(() => {
        for (const event of events) noteVisibility(store, event);
      }),
    ),
  );

describe("the visibility mirror's repair", () => {
  it("[visibility.of-event] reads the visibility a settings event leaves, with its seq, and nothing from one that leaves it alone", () => {
    expect(visibilityOf(shown(3, "public"))).toEqual({
      projectId: PRJ,
      visibility: "public",
      seq: 3,
    });
    expect(visibilityOf(shown(4, "private"))).toEqual({
      projectId: PRJ,
      visibility: "private",
      seq: 4,
    });
    expect(visibilityOf(settings(5, [{ field: "maxBatchSize", from: 1, to: 2 }]))).toBeUndefined();
    expect(
      visibilityOf(
        settings(6, [{ field: "visibility", from: "private", to: "public" }], "TrunkInitialized"),
      ),
    ).toBeUndefined();
  });

  const AWAY = "D1 is away";

  /**
   * The store and the places a Projector holds, with the project placed in an
   * org. While `away.is`, the mirror's write fails as a D1 outage would.
   */
  const projector = () => {
    const places = makeProjectNamespacesMemory(
      makeBetterAuthMemory({ orgs: [{ id: ORGS[0], slug: "acme" }] }),
    );
    const real = Effect.runSync(
      ProjectNamespaces.use((service) => Effect.succeed(service)).pipe(
        Effect.provide(places.layer),
      ),
    );
    const away = { is: false };
    const layer = Layer.mergeAll(
      makeEntityStoreMemory().layer,
      Layer.succeed(
        ProjectNamespaces,
        ProjectNamespaces.of({
          ...real,
          visibility: (projectId, visibility, seq) =>
            away.is ? Effect.die(AWAY) : real.visibility(projectId, visibility, seq),
        }),
      ),
    );
    return { layer, away };
  };

  const mirrored = ProjectNamespaces.use((places) =>
    places.shownTo({ namespaces: ORGS }, undefined, 10),
  ).pipe(Effect.map((rows) => rows.find((row) => row.projectId === PRJ)?.visibility));

  const place = ProjectNamespaces.use((places) =>
    places.assign({ projectId: PRJ, namespace: ORGS[0], name: "app" }),
  );

  const pending = EntityStore.use((store) =>
    Effect.sync(() => store.list(VISIBILITY_PENDING).map((held) => held.value)),
  );

  it.effect(
    "[projector.visibility-repair] writes the visibility it noted for a project to its place, and forgets it once written",
    () =>
      Effect.gen(function* () {
        yield* place;
        yield* note(shown(2, "public"), settings(3, [{ field: "maxBatchSize", from: 1, to: 2 }]));
        expect(yield* mirrored).toBe("private");
        expect(yield* pending).toEqual([{ visibility: "public", seq: 2 }]);
        yield* repairVisibility;
        expect(yield* mirrored).toBe("public");
        expect(yield* pending).toEqual([]);
      }).pipe(Effect.provide(projector().layer)),
  );

  it.effect(
    "[projector.visibility-newest] keeps the newest of what it noted, whatever order the events arrive in",
    () =>
      Effect.gen(function* () {
        yield* place;
        yield* note(shown(5, "public"), shown(4, "private"));
        expect(yield* pending).toEqual([{ visibility: "public", seq: 5 }]);
        yield* repairVisibility;
        expect(yield* mirrored).toBe("public");
      }).pipe(Effect.provide(projector().layer)),
  );

  it.effect(
    "[projector.visibility-retry] keeps what it noted when the write fails, and writes it at the next repair",
    () => {
      const { layer, away } = projector();
      return Effect.gen(function* () {
        yield* place;
        yield* note(shown(2, "public"));
        away.is = true;
        yield* repairVisibility;
        expect(yield* pending).toEqual([{ visibility: "public", seq: 2 }]);
        expect(yield* mirrored).toBe("private");
        away.is = false;
        yield* repairVisibility;
        expect(yield* mirrored).toBe("public");
        expect(yield* pending).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );
});
