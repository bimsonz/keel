import { describe, expect, it } from "@effect/vitest";
import { projectRepos } from "@keeltown/core/application/integration";
import { guardFileText } from "@keeltown/core/application/verification";
import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { AdmittedGuards, CodeHost } from "@keeltown/core/ports";
import {
  describeAdmittedGuardsContract,
  type FixtureFiles,
  freshId,
  makeCodeHostMemory,
  TEST_GUARD,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { AdmittedGuardsCodeHost } from "../../src/adapters/driven/gitcore/admitted-guards.ts";

const MAIN = "refs/heads/main";

/** AdmittedGuardsCodeHost over the in-memory CodeHost, with each project's guard repo written as admission writes it. */
const harness = () => {
  const host = makeCodeHostMemory();
  const trees = new Map<ProjectId, FixtureFiles>();
  /** Adds files to the project's guard repo, creating it on first use, and commits the whole tree. */
  const write = (projectId: ProjectId, files: FixtureFiles) =>
    Effect.gen(function* () {
      const repo = projectRepos(projectId).guards;
      const tree = trees.get(projectId);
      if (tree === undefined) yield* (yield* CodeHost).create(repo);
      const next = { ...tree, ...files };
      trees.set(projectId, next);
      yield* host.fixture.commit(repo, MAIN, next);
    }).pipe(Effect.provide(host.layer), Effect.orDie);
  return {
    host,
    write,
    layer: AdmittedGuardsCodeHost.pipe(Layer.provide(host.layer)),
    admit: (projectId: ProjectId, guard: typeof TEST_GUARD) =>
      write(projectId, {
        [`${guard.guardId}/guard.json`]: guardFileText({
          guardId: guard.guardId,
          probe: guard.probe,
          proposition: guard.tenet.proposition,
        }),
        [`${guard.guardId}/probe/probe.test.ts`]: "// the admitted probe",
      }),
    plantWithoutProposition: (projectId: ProjectId, guardId: string) =>
      write(projectId, {
        [`${guardId}/guard.json`]: JSON.stringify({ guardId, probe: TEST_GUARD.probe }),
      }),
  };
};

describeAdmittedGuardsContract("CodeHost", harness);

const grd = (n: number) => makeId("grd", `01JZ8PT2C4E6G8J0M2N4Q6S8V${n}`);

const list = (h: ReturnType<typeof harness>, projectId: ProjectId) =>
  Effect.gen(function* () {
    return yield* (yield* AdmittedGuards).list(projectId);
  }).pipe(Effect.provide(h.layer));

describe("AdmittedGuardsCodeHost", () => {
  it("[guard-repo.own] each project's guard repo is its own, beside trunk, and none of its other repos", () => {
    const [one, other] = [freshId("prj"), freshId("prj")].map(projectRepos);
    if (one === undefined || other === undefined) throw new Error("two projects");
    expect(one.guards.namespace).toBe(one.trunk.namespace);
    expect(one.guards.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    const all = [one, other].flatMap((r) => [r.trunk, r.staging, r.mirror, r.guards]);
    expect(new Set(all.map((r) => `${r.namespace}/${r.name}`)).size).toBe(all.length);
  });

  it.effect("[guard-repo.no-branch] a guard repo with no main yet lists no guards", () => {
    const h = harness();
    const projectId = freshId("prj");
    return Effect.gen(function* () {
      yield* (yield* CodeHost).create(projectRepos(projectId).guards);
      expect(yield* list(h, projectId)).toEqual({ admitted: [], refused: [] });
    }).pipe(Effect.provide(h.host.layer), Effect.orDie);
  });

  it.effect(
    "[guard-repo.refusals] a guard whose file is missing, symlinked, not JSON or misnamed is refused, saying why",
    () => {
      const h = harness();
      const projectId = freshId("prj");
      const [missing, linked, garbled, misnamed] = [grd(1), grd(2), grd(3), grd(4)];
      return Effect.gen(function* () {
        yield* h.admit(projectId, TEST_GUARD);
        yield* h.write(projectId, {
          [`${missing}/probe/probe.test.ts`]: "// a probe with no guard.json",
          [`${linked}/guard.json`]: { mode: "120000", data: `../${TEST_GUARD.guardId}/guard.json` },
          [`${garbled}/guard.json`]: "{ not json",
          [`${misnamed}/guard.json`]: guardFileText({
            guardId: TEST_GUARD.guardId,
            probe: TEST_GUARD.probe,
            proposition: TEST_GUARD.tenet.proposition,
          }),
          "README.md": "a file at the root is not a guard",
        });
        const { admitted, refused } = yield* list(h, projectId);
        expect(admitted.map((g) => g.guardId)).toEqual([TEST_GUARD.guardId]);
        const why = Object.fromEntries(refused.map((r) => [r.guardId, r.reason]));
        expect(why).toEqual({
          [missing]: expect.stringContaining("missing"),
          [linked]: expect.stringContaining("not a plain file"),
          [garbled]: expect.stringContaining("not JSON"),
          [misnamed]: expect.stringContaining(`names guard ${TEST_GUARD.guardId}`),
        });
      });
    },
  );

  it.effect(
    "[guard-repo.admitted] reads back what admission wrote: guard, probe and proposition",
    () => {
      const h = harness();
      const projectId = freshId("prj");
      return Effect.gen(function* () {
        yield* h.admit(projectId, TEST_GUARD);
        const { admitted } = yield* list(h, projectId);
        expect(admitted).toEqual([
          {
            guardId: TEST_GUARD.guardId,
            probe: TEST_GUARD.probe,
            tenet: { proposition: TEST_GUARD.tenet.proposition },
          },
        ]);
      });
    },
  );
});
