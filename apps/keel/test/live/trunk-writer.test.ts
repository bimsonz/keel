// TrunkWriter against Artifacts itself, on scratch repos in the staging
// workspace namespace. Sync: a scratch "trunk" is relayed into an empty repo,
// as a new project's mirror is, then again after trunk advances. Push: a
// candidate in a scratch "staging" lands on trunk only while trunk still holds
// the WAL's old value. Every repo it makes is deleted afterwards.
import { CodeHost, TrunkWriter } from "@keeltown/core/ports";
import { CodeHostFixture } from "@keeltown/testing";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { TrunkWriterGitCore } from "../../src/adapters/driven/gitcore/trunk-writer.ts";
import { artifactsFixture } from "./fixture.ts";

const NAMESPACE = "keel-ws-00";
const host = CodeHostArtifacts({ [NAMESPACE]: env.WORKSPACES });
const fixture = artifactsFixture(NAMESPACE, env.WORKSPACES);
const MAIN = "refs/heads/main";
/** An admission that admits every pack. */
const ADMITTED = () => Effect.void;
/** These cases seed nothing, so the writer needs no signing key. */
const UNSIGNED = { host: "keel.test", signingKey: undefined, signers: "[]" };

afterAll(async () => {
  await Promise.all(fixture.made.map((repo) => env.WORKSPACES.delete(repo.name)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The length of the raw pack in a receive-pack request: what follows its commands' flush. */
function packLength(body: Uint8Array): number {
  let at = 0;
  for (;;) {
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
    if (length === 0) return body.length - at - 4;
    at += length;
  }
}

it("[sync.live] relays trunk into an empty repo, then each new head, keeping commit ids; again is a no-op", async () => {
  const trunk = fixture.fixture.scratch();
  const mirror = fixture.fixture.scratch();
  const missing = fixture.fixture.scratch();
  const run = <A, E>(program: Effect.Effect<A, E, CodeHost | CodeHostFixture | TrunkWriter>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            TrunkWriterGitCore({ trunk, staging: trunk }, UNSIGNED).pipe(Layer.provide(host)),
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
            TrunkWriterGitCore({ trunk, staging }, UNSIGNED).pipe(Layer.provide(host)),
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
      yield* writer.push(base, first, ADMITTED);
      const landed = yield* codeHost.head(trunk, MAIN);
      const stale = yield* Effect.flip(writer.push(base, second, ADMITTED));
      const afterStale = yield* codeHost.head(trunk, MAIN);
      yield* writer.push(first, second, ADMITTED);
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

it("[trunkwriter.live-pack-bytes] weighs a promotion's pack as exactly the bytes its push admits and then sends to trunk, fetched from staging once", async () => {
  const trunk = fixture.fixture.scratch();
  const staging = fixture.fixture.scratch();
  const run = <A, E>(program: Effect.Effect<A, E, CodeHost | CodeHostFixture | TrunkWriter>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            TrunkWriterGitCore({ trunk, staging }, UNSIGNED).pipe(Layer.provide(host)),
            host,
            fixture.layer,
          ),
        ),
      ),
    );
  // Every pack a receive-pack request carries from here on, by length, and how many packs were asked for; each request itself goes out untouched.
  const sent: number[] = [];
  let fetches = 0;
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    if (url.endsWith("/git-receive-pack") && body instanceof Uint8Array)
      sent.push(packLength(body));
    if (url.endsWith("/git-upload-pack")) fetches += 1;
    return real(input, init);
  });
  /** What each push gave its admission, in order. */
  const admitted: number[] = [];
  const admit = (packBytes: number) =>
    Effect.sync(() => {
      admitted.push(packBytes);
    });
  // Lines that share nothing, so the first pack is a few kilobytes even compressed.
  const prose = Array.from(
    { length: 400 },
    (_, i) => `${i} ${(i * 2_654_435_761) % 4_294_967_291}`,
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
      const first = yield* commit(staging, MAIN, { "README.md": `${prose.join("\n")}\n` });
      const second = yield* commit(staging, MAIN, { "README.md": "second\n" });
      sent.length = 0;
      const historyAtBase = yield* writer.historyBytes(base);
      const weighing = Date.now();
      const firstBytes = yield* writer.packBytes(base, first);
      const weighMs = Date.now() - weighing;
      const again = yield* writer.packBytes(base, first);
      const unsent = [...sent];
      const pushing = Date.now();
      const fetchedBefore = fetches;
      yield* writer.push(base, first, admit);
      const pushFetches = fetches - fetchedBefore;
      const pushMs = Date.now() - pushing;
      const secondBytes = yield* writer.packBytes(first, second);
      yield* writer.push(first, second, admit);
      const whole = yield* writer.packBytes(base, second);
      const landed = yield* codeHost.head(trunk, MAIN);
      const history = yield* writer.historyBytes(second);
      return {
        second,
        firstBytes,
        again,
        unsent,
        secondBytes,
        whole,
        landed,
        historyAtBase,
        history,
        weighMs,
        pushMs,
        pushFetches,
      };
    }),
  );
  console.log(
    `LIVE packBytes: base → first weighed ${report.firstBytes} bytes (asked again: ${report.again}) and its push admitted ${admitted[0]}, sent ${sent[0]} and asked staging for ${report.pushFetches} pack; first → second weighed ${report.secondBytes} and its push sent ${sent[1]}; base → second in one pack would weigh ${report.whole}, the two less one pack's 32 bytes = ${report.firstBytes + report.secondBytes - 32}`,
  );
  console.log(
    `LIVE historyBytes: trunk at its base ${report.historyAtBase} bytes; after the two landings ${report.history}, and the meter's sum is ${report.historyAtBase} + (${report.firstBytes} - 32) + (${report.secondBytes} - 32) = ${report.historyAtBase + report.firstBytes - 32 + report.secondBytes - 32}. Weighing the first pack took ${report.weighMs} ms and pushing it ${report.pushMs} ms, from this machine`,
  );
  // The meter: the history at create plus each landed pack less 32 bytes is the repo's history now.
  expect(report.history).toBe(
    report.historyAtBase + report.firstBytes - 32 + report.secondBytes - 32,
  );
  expect(report.unsent).toEqual([]);
  expect(report.again).toBe(report.firstBytes);
  expect(sent).toEqual([report.firstBytes, report.secondBytes]);
  expect(admitted).toEqual(sent);
  expect(report.pushFetches).toBe(1);
  expect(report.firstBytes).toBeGreaterThan(1024);
  expect(report.whole).toBe(report.firstBytes + report.secondBytes - 32);
  expect(report.landed).toBe(report.second);
});

it("[take.live] brings an empty repo its source's whole history in one fetch and one push, keeping commit ids, and answers the length of the pack it sent, which is what the history weighs there; a retry, and one after the source moved on, asks nothing and answers the main it has; a source that is gone is RepoNotFound", async () => {
  const source = fixture.fixture.scratch();
  const trunk = fixture.fixture.scratch();
  const missing = fixture.fixture.scratch();
  const run = <A, E>(program: Effect.Effect<A, E, CodeHost | CodeHostFixture | TrunkWriter>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            TrunkWriterGitCore({ trunk, staging: trunk }, UNSIGNED).pipe(Layer.provide(host)),
            host,
            fixture.layer,
          ),
        ),
      ),
    );
  // Every git request from here on, by its service; each goes out untouched.
  const asked: string[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const service = /\/git-(upload|receive)-pack$/.exec(url)?.[1];
    if (service !== undefined) asked.push(service);
    return real(input, init);
  });

  const report = await run(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      const writer = yield* TrunkWriter;
      const commit = (yield* CodeHostFixture).commit;
      yield* codeHost.create(source);
      yield* codeHost.create(trunk);
      const root = yield* commit(source, MAIN, { "README.md": "one\n" });
      const first = yield* commit(source, MAIN, { "README.md": "two\n", "src/a.ts": "a\n" });
      asked.length = 0;
      const gone = yield* Effect.flip(writer.take(missing));
      const beforeTake = [...asked];
      const taken = yield* writer.take(source);
      const forTake = [...asked];
      const main = yield* codeHost.head(trunk, MAIN);
      const parents = (yield* codeHost.readCommit(trunk, main)).parents;
      const weighs = yield* writer.historyBytes(main);
      asked.length = 0;
      const again = yield* writer.take(source);
      const forAgain = [...asked];
      // The fixture's own push moves the source on: counted apart from what the take asks.
      const later = yield* commit(source, MAIN, { "README.md": "three\n" });
      asked.length = 0;
      const afterMove = yield* writer.take(source);
      const forAfterMove = [...asked];
      const still = yield* codeHost.head(trunk, MAIN);
      return {
        root,
        first,
        gone,
        beforeTake,
        taken,
        forTake,
        main,
        parents,
        weighs,
        again,
        forAgain,
        later,
        afterMove,
        forAfterMove,
        still,
      };
    }),
  );
  console.log(
    `LIVE take: gone ${report.gone._tag} (asked ${JSON.stringify(report.beforeTake)}); took ${report.taken.head === report.first ? "the source's head" : "another commit"} (its pack ${report.taken.bytes} B, the history there ${report.weighs} B) with ${JSON.stringify(report.forTake)}, its parent ${report.parents[0] === report.root ? "==" : "!="} the source's root; again ${report.again.head === report.first ? "the same" : "moved"} with ${JSON.stringify(report.forAgain)}; after the source moved on ${report.afterMove.head === report.first ? "the same" : "moved"} with ${JSON.stringify(report.forAfterMove)}, main ${report.still === report.first ? "unmoved" : "moved"}`,
  );
  expect(report.gone).toMatchObject({ _tag: "RepoNotFound" });
  expect(report.beforeTake).toEqual([]);
  expect(report.taken.head).toBe(report.first);
  expect(report.taken.bytes).toBe(report.weighs);
  expect(report.forTake).toEqual(["upload", "receive"]);
  expect(report.main).toBe(report.first);
  expect(report.parents).toEqual([report.root]);
  expect(report.later).not.toBe(report.first);
  expect(report.again).toEqual({ head: report.first });
  expect(report.forAgain).toEqual([]);
  expect(report.afterMove).toEqual({ head: report.first });
  expect(report.forAfterMove).toEqual([]);
  expect(report.still).toBe(report.first);
});
