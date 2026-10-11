// TrunkWriter against Artifacts itself, on scratch repos in the staging
// workspace namespace. Sync: a scratch "trunk" is relayed into an empty repo,
// as a new project's mirror is, then again after trunk advances. Push: a
// candidate in a scratch "staging" lands on trunk only while trunk still holds
// the WAL's old value. Every repo it makes is deleted afterwards.
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
          Layer.mergeAll(
            TrunkWriterGitCore({ trunk, staging: trunk }).pipe(Layer.provide(host)),
            host,
            fixture.layer,
          ),
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

it("[trunkwriter.live] lands a staging commit on trunk byte for byte, and refuses it once trunk has moved past the old value", async () => {
  const trunk = fixture.fixture.scratch();
  const staging = fixture.fixture.scratch();
  const run = <A, E>(program: Effect.Effect<A, E, CodeHost | CodeHostFixture | TrunkWriter>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            TrunkWriterGitCore({ trunk, staging }).pipe(Layer.provide(host)),
            host,
            fixture.layer,
          ),
        ),
      ),
    );

  const report = await run(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      const writer = yield* TrunkWriter;
      const commit = (yield* CodeHostFixture).commit;
      yield* codeHost.create(trunk);
      yield* codeHost.create(staging);
      const base = yield* commit(trunk, MAIN, { "README.md": "base\n" });
      expect(yield* commit(staging, MAIN, { "README.md": "base\n" })).toBe(base);
      const first = yield* commit(staging, MAIN, { "README.md": "first\n" });
      const second = yield* commit(staging, MAIN, { "README.md": "second\n" });
      yield* writer.push(base, first);
      const landed = yield* codeHost.head(trunk, MAIN);
      const stale = yield* Effect.flip(writer.push(base, second));
      const afterStale = yield* codeHost.head(trunk, MAIN);
      yield* writer.push(first, second);
      const afterSecond = yield* codeHost.head(trunk, MAIN);
      return { base, first, second, landed, stale, afterStale, afterSecond };
    }),
  );
  console.log(
    `LIVE push: base → first ${report.landed === report.first ? "landed" : "did not land"}; stale base → second ${report.stale._tag}${report.stale._tag === "PushRejected" ? ` (${report.stale.reason})` : ""}, trunk ${report.afterStale === report.first ? "still at first" : "moved"}; first → second ${report.afterSecond === report.second ? "landed" : "did not land"}`,
  );
  expect(report.landed).toBe(report.first);
  expect(report.stale).toMatchObject({ _tag: "PushRejected", reason: "stale" });
  expect(report.afterStale).toBe(report.first);
  expect(report.afterSecond).toBe(report.second);
});
