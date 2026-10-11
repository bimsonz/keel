// WorkspaceRebaser against Artifacts itself, on scratch repos in the staging
// workspace namespace: the contract, then what an agent's `git fetch origin
// keel/trunk` sees after a rebase. Every repo it makes is deleted afterwards.
import { CodeHost, KEEL_TRUNK_REF, WorkspaceRebaser } from "@keeltown/core/ports";
import { CodeHostFixture, PORTS } from "@keeltown/testing";
import { advertisedRefs } from "@keeltown/gitcore";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { WorkspaceRebaserGitCore } from "../../src/adapters/driven/gitcore/workspace-rebaser.ts";
import { artifactsFixture } from "./fixture.ts";

const NAMESPACE = "keel-ws-00";
const MAIN = "refs/heads/main";
const host = CodeHostArtifacts({ [NAMESPACE]: env.WORKSPACES });
const fixture = artifactsFixture(NAMESPACE, env.WORKSPACES);

afterAll(async () => {
  await Promise.all(fixture.made.map((repo) => env.WORKSPACES.delete(repo.name)));
});

const harness = () => {
  const trunk = fixture.fixture.scratch();
  return {
    trunk,
    layer: Layer.mergeAll(
      WorkspaceRebaserGitCore({ trunk }).pipe(Layer.provide(host)),
      host,
      fixture.layer,
    ),
  };
};

PORTS.WorkspaceRebaser.contract("artifacts (keel-ws-00)", harness);

it("[rebaser.live] a workspace forked before trunk moved advertises trunk's head as keel/trunk, which its clone can read", async () => {
  const { trunk, layer } = harness();
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      const commit = (yield* CodeHostFixture).commit;
      const rebaser = yield* WorkspaceRebaser;
      yield* codeHost.create(trunk);
      const base = yield* commit(trunk, MAIN, { "README.md": "base\n" });
      const workspace = yield* codeHost.fork(trunk, fixture.fixture.scratch());
      const landed = yield* commit(trunk, MAIN, { "README.md": "landed\n", "src/a.ts": "a\n" });
      const started = Date.now();
      const outcome = yield* rebaser.pushTrunk(workspace, base, landed);
      const ms = Date.now() - started;
      // What `git fetch origin keel/trunk` asks for: the workspace's advertisement, with a clone's read token.
      const info = yield* codeHost.info(workspace);
      const token = yield* codeHost.mintToken(workspace, "read", 60);
      const advertised = yield* Effect.promise(() =>
        advertisedRefs({ url: info.remote, token: token.token }),
      );
      const tree = yield* codeHost.readTree(workspace, landed);
      return {
        base,
        landed,
        outcome,
        ms,
        advertised,
        tree,
        main: yield* codeHost.head(workspace, MAIN),
      };
    }).pipe(Effect.provide(layer)),
  );
  const keelTrunk = report.advertised.get(KEEL_TRUNK_REF);
  console.log(
    `LIVE rebaser: pushTrunk ${report.outcome} in ${report.ms} ms; advertised keel/trunk ${keelTrunk === report.landed ? "==" : "!="} trunk's head, main ${report.main === report.base ? "==" : "!="} base; tree paths ${report.tree.map((e) => e.path).join(",")}`,
  );
  expect(report.outcome).toBe("advanced");
  expect(keelTrunk).toBe(report.landed);
  expect(report.advertised.get(MAIN)).toBe(report.base);
  expect(report.tree.map((e) => e.path)).toEqual(["README.md", "src", "src/a.ts"]);
});
