// TrunkWriter's sync against Artifacts itself: a scratch "trunk" in the
// staging workspace namespace is relayed into an empty scratch repo, as a new
// project's mirror is, then again after trunk advances. Every repo it makes is
// deleted afterwards.
import { CodeHost, TrunkWriter } from "@keeltown/core/ports";
import { CodeHostFixture } from "@keeltown/testing";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { TrunkWriterGitCore } from "../../src/adapters/driven/gitcore/trunk-writer.ts";
import { artifactsFixture } from "./fixture.ts";

const NAMESPACE = "keel-ws-00";
const host = CodeHostArtifacts({ [NAMESPACE]: env.WORKSPACES });
const fixture = artifactsFixture(NAMESPACE, env.WORKSPACES);
const MAIN = "refs/heads/main";

afterAll(async () => {
  await Promise.all(fixture.made.map((repo) => env.WORKSPACES.delete(repo.name)));
});

it("[sync.live] relays trunk into an empty repo, then each new head, keeping commit ids; again is a no-op", async () => {
  const trunk = fixture.fixture.scratch();
  const mirror = fixture.fixture.scratch();
  const missing = fixture.fixture.scratch();
  const run = <A, E>(program: Effect.Effect<A, E, CodeHost | CodeHostFixture | TrunkWriter>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(TrunkWriterGitCore(trunk).pipe(Layer.provide(host)), host, fixture.layer),
        ),
      ),
    );

  const report = await run(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      const writer = yield* TrunkWriter;
      const commit = (yield* CodeHostFixture).commit;
      yield* codeHost.create(trunk);
      yield* codeHost.create(mirror);
      const first = yield* commit(trunk, MAIN, { "README.md": "one\n" });
      const toEmpty = yield* writer.sync([mirror]);
      const afterFirst = yield* codeHost.head(mirror, MAIN);
      const second = yield* commit(trunk, MAIN, { "README.md": "two\n" });
      const toStale = yield* writer.sync([mirror]);
      const afterSecond = yield* codeHost.head(mirror, MAIN);
      const again = yield* writer.sync([mirror]);
      const notThere = yield* Effect.flip(writer.sync([missing]));
      return { first, toEmpty, afterFirst, second, toStale, afterSecond, again, notThere };
    }),
  );
  console.log(
    `LIVE sync: into empty ${JSON.stringify(report.toEmpty.outcomes)} (mirror ${report.afterFirst === report.first ? "==" : "!="} trunk), after an advance ${JSON.stringify(report.toStale.outcomes)} (mirror ${report.afterSecond === report.second ? "==" : "!="} trunk), again ${JSON.stringify(report.again.outcomes)}, missing target ${report.notThere._tag}`,
  );
  expect(report.toEmpty).toEqual({ head: report.first, outcomes: ["advanced"] });
  expect(report.afterFirst).toBe(report.first);
  expect(report.toStale).toEqual({ head: report.second, outcomes: ["advanced"] });
  expect(report.afterSecond).toBe(report.second);
  expect(report.again).toEqual({ head: report.second, outcomes: ["unchanged"] });
  expect(report.notThere._tag).toBe("RepoNotFound");
});
