import { describe, expect, it } from "@effect/vitest";
import { projectRepos } from "@keeltown/core/application/integration";
import { guardFileText, type ProbeFile } from "@keeltown/core/application/verification";
import { CommitSha, contentHashOf, makeId, type ProjectId } from "@keeltown/core/kernel";
import { AdmittedGuards, CodeHost } from "@keeltown/core/ports";
import { hashObject, type RefUpdate, ZERO_OID } from "@keeltown/gitcore";
import {
  describeAdmittedGuardsContract,
  type FixtureFile,
  type FixtureFiles,
  freshId,
  makeCodeHostMemory,
  TEST_GUARD,
} from "@keeltown/testing";
import { Effect, Layer } from "effect";
import {
  AdmittedGuardsCodeHost,
  type GuardPush,
} from "../../src/adapters/driven/gitcore/admitted-guards.ts";

const MAIN = "refs/heads/main";

/**
 * A guard repo push into the in-memory CodeHost, as receive-pack applies one:
 * every object stored, and the ref moved only if it still holds `old`.
 */
const memoryPush =
  (host: ReturnType<typeof makeCodeHostMemory>, pushes: RefUpdate[] = []): GuardPush =>
  (repo, update, objects) =>
    Effect.promise(async () => {
      pushes.push(update);
      const stored = host.repos.get(`${repo.namespace}/${repo.name}`);
      if (stored === undefined) throw new Error("push to a repo that does not exist");
      if ((stored.refs.get(update.ref) ?? ZERO_OID) !== update.old)
        return {
          kind: "rejected",
          unpack: "ok",
          refs: { [update.ref]: { ok: false, reason: "stale" } },
        };
      for (const o of objects) stored.objects.set(await hashObject(o.type, o.body), o);
      stored.refs.set(update.ref, CommitSha.make(update.new));
      return { kind: "applied" };
    });

/** AdmittedGuardsCodeHost over the in-memory CodeHost, admitting through its own push; `write` plants whole trees as an agent never could. */
const harness = () => {
  const host = makeCodeHostMemory();
  const pushes: RefUpdate[] = [];
  /** Adds files to main's tree in the project's guard repo, creating the repo on first use. */
  const write = (projectId: ProjectId, files: FixtureFiles) =>
    Effect.gen(function* () {
      const repo = projectRepos(projectId).guards;
      const code = yield* CodeHost;
      yield* code.create(repo).pipe(Effect.catchTag("RepoAlreadyExists", () => Effect.void));
      const head = yield* code.head(repo, MAIN).pipe(
        Effect.map((sha): CommitSha | undefined => sha),
        Effect.catchTag("RefNotFound", () => Effect.succeed(undefined)),
      );
      const held: Record<string, FixtureFile> = {};
      for (const e of head === undefined ? [] : yield* code.readTree(repo, head)) {
        if (e.type !== "blob") continue;
        const data = yield* code.readBlob(repo, e.oid);
        held[e.path] = e.mode === "120000" || e.mode === "100755" ? { mode: e.mode, data } : data;
      }
      yield* host.fixture.commit(repo, MAIN, { ...held, ...files });
    }).pipe(Effect.provide(host.layer), Effect.orDie);
  const layer = AdmittedGuardsCodeHost(memoryPush(host, pushes)).pipe(Layer.provide(host.layer));
  return {
    host,
    pushes,
    write,
    layer,
    admit: (projectId: ProjectId, guard: typeof TEST_GUARD, files: readonly ProbeFile[] = PROBE) =>
      Effect.gen(function* () {
        return yield* (yield* AdmittedGuards).admit(
          projectId,
          { guardId: guard.guardId, probe: guard.probe, proposition: guard.tenet.proposition },
          files,
        );
      }).pipe(Effect.provide(layer)),
    plantWithoutProposition: (projectId: ProjectId, guardId: string) =>
      write(projectId, {
        [`${guardId}/guard.json`]: JSON.stringify({ guardId, probe: TEST_GUARD.probe }),
      }),
  };
};

const PROBE: readonly ProbeFile[] = [
  { path: ".keel/freshness.test.ts", text: "// the admitted probe\n" },
];

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
        yield* h.admit(projectId, TEST_GUARD);
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

  it.effect(
    "[guard-repo.admit-writes] admission commits guard.json and the probe's files under the guard's directory onto main, as Keel, creating the repo",
    () => {
      const h = harness();
      const projectId = freshId("prj");
      const repo = projectRepos(projectId).guards;
      return Effect.gen(function* () {
        const commit = yield* h.admit(projectId, TEST_GUARD);
        const host = yield* CodeHost;
        expect(yield* host.head(repo, MAIN)).toBe(commit);
        const info = yield* host.readCommit(repo, commit);
        expect(info.parents).toEqual([]);
        expect([info.author.name, info.committer.name]).toEqual(["Keel", "Keel"]);
        const files = Object.fromEntries(
          yield* Effect.forEach(
            (yield* host.readTree(repo, commit)).filter((e) => e.type === "blob"),
            (e) =>
              Effect.map(host.readBlob(repo, e.oid), (b) => [e.path, new TextDecoder().decode(b)]),
          ),
        );
        expect(files).toEqual({
          [`${TEST_GUARD.guardId}/guard.json`]: guardFileText({
            guardId: TEST_GUARD.guardId,
            probe: TEST_GUARD.probe,
            proposition: TEST_GUARD.tenet.proposition,
          }),
          [`${TEST_GUARD.guardId}/probe/.keel/freshness.test.ts`]: "// the admitted probe\n",
        });
      }).pipe(Effect.provide(h.host.layer));
    },
  );

  it.effect(
    "[guard-repo.admit-keeps] a later admission is parented on main and keeps every guard already there",
    () => {
      const h = harness();
      const projectId = freshId("prj");
      const other = { ...TEST_GUARD, guardId: grd(5) };
      return Effect.gen(function* () {
        const first = yield* h.admit(projectId, TEST_GUARD);
        const second = yield* h.admit(projectId, other);
        const info = yield* (yield* CodeHost).readCommit(projectRepos(projectId).guards, second);
        expect(info.parents).toEqual([first]);
        expect((yield* list(h, projectId)).admitted.map((g) => g.guardId).toSorted()).toEqual(
          [TEST_GUARD.guardId, other.guardId].toSorted(),
        );
      }).pipe(Effect.provide(h.host.layer));
    },
  );

  it.live(
    "[guard-repo.admit-race] a push that lost the race to another admission reads main again and keeps the other's guard",
    () => {
      const host = makeCodeHostMemory();
      const projectId = freshId("prj");
      const raced = { ...TEST_GUARD, guardId: grd(6) };
      const push = memoryPush(host);
      let races = 1;
      // The first push finds main moved by another admission between its read and its push.
      const racing: GuardPush = (repo, update, objects) =>
        Effect.gen(function* () {
          if (races > 0) {
            races -= 1;
            yield* host.fixture
              .commit(repo, MAIN, {
                [`${raced.guardId}/guard.json`]: guardFileText({
                  guardId: raced.guardId,
                  probe: raced.probe,
                  proposition: raced.tenet.proposition,
                }),
              })
              .pipe(Effect.orDie);
          }
          return yield* push(repo, update, objects);
        });
      const layer = AdmittedGuardsCodeHost(racing).pipe(Layer.provide(host.layer));
      return Effect.gen(function* () {
        const guards = yield* AdmittedGuards;
        yield* guards.admit(
          projectId,
          {
            guardId: TEST_GUARD.guardId,
            probe: TEST_GUARD.probe,
            proposition: TEST_GUARD.tenet.proposition,
          },
          PROBE,
        );
        expect((yield* guards.list(projectId)).admitted.map((g) => g.guardId).toSorted()).toEqual(
          [TEST_GUARD.guardId, raced.guardId].toSorted(),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "[guard-repo.admit-once] a guard already admitted as another guard is never overwritten",
    () => {
      const h = harness();
      const projectId = freshId("prj");
      return Effect.gen(function* () {
        yield* h.admit(projectId, TEST_GUARD);
        const pushed = h.pushes.length;
        const again = yield* Effect.exit(
          h.admit(projectId, { ...TEST_GUARD, probe: contentHashOf({ probe: "another" }) }),
        );
        expect(again._tag).toBe("Failure");
        expect(h.pushes.length).toBe(pushed);
      });
    },
  );
});
