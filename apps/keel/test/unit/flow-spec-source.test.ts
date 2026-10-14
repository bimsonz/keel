import { describe, expect, it } from "@effect/vitest";
import { CodeHost, FlowSpecSource } from "@keeltown/core/ports";
import { describeFlowSpecSourceContract, makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer } from "effect";
import { FlowSpecSourceCodeHost } from "../../src/adapters/driven/gitcore/flow-spec-source.ts";

const MAIN = "refs/heads/main";

/** FlowSpecSourceCodeHost over the in-memory CodeHost, which keeps real git objects. */
const harness = () => {
  const host = makeCodeHostMemory();
  return {
    host,
    layer: FlowSpecSourceCodeHost.pipe(Layer.provide(host.layer)),
    commit: (files: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        const repo = yield* (yield* CodeHost).create(host.fixture.scratch());
        const base = yield* host.fixture.commit(repo, MAIN, files);
        return { repo, base };
      }).pipe(Effect.provide(host.layer), Effect.orDie),
  };
};

/** CodeHost with each call of every one of its methods logged by name in `calls`, before it runs. */
const logging = (calls: string[]) => {
  const logged =
    <Args extends readonly unknown[], A, E>(
      name: string,
      method: (...args: Args) => Effect.Effect<A, E>,
    ) =>
    (...args: Args): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        calls.push(name);
        return method(...args);
      });
  return Layer.effect(
    CodeHost,
    Effect.map(CodeHost, (host) =>
      CodeHost.of({
        create: logged("create", host.create),
        fork: logged("fork", host.fork),
        import: logged("import", host.import),
        branches: logged("branches", host.branches),
        mintToken: logged("mintToken", host.mintToken),
        info: logged("info", host.info),
        head: logged("head", host.head),
        hasCommit: logged("hasCommit", host.hasCommit),
        isAncestor: logged("isAncestor", host.isAncestor),
        readTree: logged("readTree", host.readTree),
        readBlob: logged("readBlob", host.readBlob),
        readBlobs: logged("readBlobs", host.readBlobs),
        listDir: logged("listDir", host.listDir),
        readCommit: logged("readCommit", host.readCommit),
        log: logged("log", host.log),
        diffTrees: logged("diffTrees", host.diffTrees),
        delete: logged("delete", host.delete),
      }),
    ),
  );
};

/** Commits `files` to a fresh repo and reads its flow sources over a logged CodeHost: the sources, and the calls the read made. */
const loggedRead = (files: Readonly<Record<string, string>>) => {
  const h = harness();
  const calls: string[] = [];
  const layer = FlowSpecSourceCodeHost.pipe(
    Layer.provide(logging(calls).pipe(Layer.provide(h.host.layer))),
  );
  return Effect.gen(function* () {
    const { repo, base } = yield* h.commit(files);
    const sources = yield* (yield* FlowSpecSource).read(repo, base);
    return { sources, calls };
  }).pipe(Effect.provide(layer));
};

const FLOW = '{"stages":[]}';
const PACKAGE = '{"name":"app"}';

describeFlowSpecSourceContract("CodeHost", harness);

describe("FlowSpecSourceCodeHost", () => {
  it.effect(
    "[flow-source.base-not-head] reads the commit it is given, not the ref's newer head: its flow and its deploy spec",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { repo, base } = yield* h.commit({
          ".keel/flow.json": "base",
          ".keel/deploy.json": "base deploy",
          "package.json": "{}",
        });
        yield* h.host.fixture
          .commit(repo, MAIN, {
            ".keel/flow.json": "head",
            ".keel/deploy.json": "head deploy",
            "package.json": "{}",
          })
          .pipe(Effect.provide(h.host.layer), Effect.orDie);
        const sources = yield* (yield* FlowSpecSource).read(repo, base);
        expect([sources.flowJson, sources.deployJson]).toEqual(["base", "base deploy"]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "[flow-source.no-symlink] a symlinked package.json or flow is not followed: it reads as absent",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const repo = yield* (yield* CodeHost).create(h.host.fixture.scratch());
        const base = yield* h.host.fixture.commit(repo, MAIN, {
          "package.json": { mode: "120000", data: "../elsewhere/package.json" },
          ".keel/flow.json": { mode: "120000", data: "../../flow.json" },
          ".keel/deploy.json": { mode: "120000", data: "../../deploy.json" },
        });
        const sources = yield* Effect.gen(function* () {
          return yield* (yield* FlowSpecSource).read(repo, base);
        }).pipe(Effect.provide(h.layer));
        expect(sources.packageJson).toBeUndefined();
        expect(sources.flowJson).toBeUndefined();
        expect(sources.deployJson).toBeUndefined();
      }).pipe(Effect.provide(h.host.layer), Effect.orDie);
    },
  );

  it.effect(
    "[flow-source.reads-two-listings] reads the root's and .keel's listings and the two files, the same calls for a large repo as for a small one",
    () => {
      const small = { ".keel/flow.json": FLOW, "package.json": PACKAGE, "src/a.ts": "a\n" };
      // 300 files in 60 directories two levels under lib/.
      const large = {
        ...small,
        ...Object.fromEntries(
          Array.from({ length: 300 }, (_, n) => [
            `lib/g${n % 12}/s${Math.floor(n / 12) % 5}/f${n}.ts`,
            `${n}\n`,
          ]),
        ),
      };
      return Effect.gen(function* () {
        const fromSmall = yield* loggedRead(small);
        const fromLarge = yield* loggedRead(large);
        expect(fromLarge.calls).toEqual(fromSmall.calls);
        expect(fromSmall.calls.toSorted()).toEqual(["listDir", "listDir", "readBlob", "readBlob"]);
        expect(fromSmall.sources).toEqual({
          rootPaths: [".keel", "package.json", "src"],
          flowJson: FLOW,
          packageJson: PACKAGE,
        });
        expect(fromLarge.sources).toEqual({
          rootPaths: [".keel", "lib", "package.json", "src"],
          flowJson: FLOW,
          packageJson: PACKAGE,
        });
      });
    },
  );

  it.effect(
    "[flow-source.no-keel-dir] a root with no .keel directory is listed alone, whether .keel is absent or a plain file, and answers no flow",
    () =>
      Effect.gen(function* () {
        const absent = yield* loggedRead({ "package.json": PACKAGE, "src/a.ts": "a\n" });
        expect(absent.calls).toEqual(["listDir", "readBlob"]);
        expect(absent.sources).toEqual({
          rootPaths: ["package.json", "src"],
          packageJson: PACKAGE,
        });
        const file = yield* loggedRead({ ".keel": "not a directory\n", "package.json": PACKAGE });
        expect(file.calls).toEqual(["listDir", "readBlob"]);
        expect(file.sources).toEqual({
          rootPaths: [".keel", "package.json"],
          packageJson: PACKAGE,
        });
      }),
  );
});
