// WorkspaceRefresher against Artifacts itself, on scratch repos in the staging
// workspace namespace: the contract (a stale main refused by Artifacts' own
// compare-and-swap among it), then how long a refresh of a workspace two
// landings behind takes. Every repo it makes is deleted afterwards.
import { makeId } from "@keeltown/core/kernel";
import { CodeHost, WorkspaceRefresher } from "@keeltown/core/ports";
import { CodeHostFixture, PORTS } from "@keeltown/testing";
import { advertisedRefs } from "@keeltown/gitcore";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { WorkspaceRefresherGitCore } from "../../src/adapters/driven/gitcore/workspace-refresher.ts";
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
    projectId: makeId("prj", "01KRBSRCNTRCT0000000000000"),
    trunk,
    layer: Layer.mergeAll(
      WorkspaceRefresherGitCore(() => trunk).pipe(Layer.provide(host)),
      host,
      fixture.layer,
    ),
  };
};

PORTS.WorkspaceRefresher.contract("artifacts (keel-ws-00)", harness);

it("[refresher.live] a workspace forked two landings ago advertises trunk's head as its main after one refresh", async () => {
  const { projectId, trunk, layer } = harness();
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      const commit = (yield* CodeHostFixture).commit;
      const refresher = yield* WorkspaceRefresher;
      yield* codeHost.create(trunk);
      const base = yield* commit(trunk, MAIN, { "README.md": "base\n" });
      const workspace = yield* codeHost.fork(trunk, fixture.fixture.scratch());
      yield* commit(trunk, MAIN, { "README.md": "first\n" });
      const head = yield* commit(trunk, MAIN, { "README.md": "second\n", "src/a.ts": "a\n" });
      const started = Date.now();
      const outcome = yield* refresher.advance(projectId, workspace, base, head);
      const ms = Date.now() - started;
      // What a clone of the workspace sees: its advertisement, with a read token.
      const info = yield* codeHost.info(workspace);
      const token = yield* codeHost.mintToken(workspace, "read", 60);
      const advertised = yield* Effect.promise(() =>
        advertisedRefs({ url: info.remote, token: token.token }),
      );
      return { head, outcome, ms, advertised, tree: yield* codeHost.readTree(workspace, head) };
    }).pipe(Effect.provide(layer)),
  );
  console.log(
    `LIVE refresher: advance ${report.outcome} in ${report.ms} ms; advertised main ${report.advertised.get(MAIN) === report.head ? "==" : "!="} trunk's head; tree paths ${report.tree.map((e) => e.path).join(",")}`,
  );
  expect(report.outcome).toBe("advanced");
  expect(report.advertised.get(MAIN)).toBe(report.head);
  expect(report.tree.map((e) => e.path)).toEqual(["README.md", "src", "src/a.ts"]);
});
