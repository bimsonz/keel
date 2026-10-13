// The GitCore composer against Artifacts itself: three agents' workspaces and
// a staging repo in the staging workspace namespace, a candidate restacked by
// reading through the binding and pushed to staging, then read back through
// the binding. Every repo it makes is deleted afterwards.
import { type CommitSha, Instant, makeId } from "@keeltown/core/kernel";
import { CandidateComposer, CodeHost, type RepoRef } from "@keeltown/core/ports";
import { Budget, DIFF_BUDGET, mergeText } from "@keeltown/gitcore";
import { CodeHostFixture } from "@keeltown/testing";
import { makeCommitSigningKeys } from "@keeltown/testing/commit-signing-keys";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { ArtifactsObjects } from "../../src/adapters/driven/artifacts/objects.ts";
import { CandidateComposerGitCore } from "../../src/adapters/driven/gitcore/candidate-composer.ts";
import { artifactsFixture } from "./fixture.ts";

const NAMESPACE = "keel-ws-00";
const host = CodeHostArtifacts({ [NAMESPACE]: env.WORKSPACES });
const fixture = artifactsFixture(NAMESPACE, env.WORKSPACES);
const composer = CandidateComposerGitCore(ArtifactsObjects({ [NAMESPACE]: env.WORKSPACES }), {
  host: "keel.test",
  ...(await makeCommitSigningKeys()),
});
const MAIN = "refs/heads/main";
const AT = Instant(Date.UTC(2026, 9, 11, 9, 0, 0));

afterAll(async () => {
  await Promise.all(fixture.made.map((repo) => env.WORKSPACES.delete(repo.name)));
});

const BASE = {
  "README.md": "keel\n",
  "src/a.ts": "export const a = 1;\n",
  "docs/old.md": "old\n",
};
const ulid = (n: number) => `01JA0000000000000000000${String(n).padStart(3, "0")}`;
const changeId = (n: number) => makeId("chg", ulid(n));
const agentId = (n: number) => makeId("agt", ulid(n));
const candidateId = (n: number) => makeId("cnd", ulid(n));

const run = <A, E>(program: Effect.Effect<A, E, CodeHost | CodeHostFixture | CandidateComposer>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(composer.pipe(Layer.provide(host)), host, fixture.layer)),
    ),
  );

/** One commit as the binding reads it back. */
async function readBack(repo: RepoRef, sha: string) {
  const handle = await env.WORKSPACES.get(repo.name);
  try {
    const c = await handle.readCommit(sha);
    if (c === null) throw new Error(`${sha} is not in ${repo.name}`);
    return {
      parents: c.parents,
      author: `${c.author.name} <${c.author.email}> ${c.authoredAt}`,
      committer: `${c.committer.name} <${c.committer.email}> ${c.committedAt}`,
      changeId: /^Change-Id: (.+)$/m.exec(c.message)?.[1],
      agent: /^Keel-Agent: (.+)$/m.exec(c.message)?.[1],
      declared: /^Declared-Author: (.+)$/m.exec(c.message)?.[1],
      authoredAt: c.authoredAt,
      title: c.message.split("\n")[0],
    };
  } finally {
    handle[Symbol.dispose]();
  }
}

it("[composer.live] composes a three-change candidate through the binding and pushes it to staging; a conflicting batch is refused", async () => {
  const staging = fixture.fixture.scratch();
  const workspaces = [0, 1, 2, 3].map(() => fixture.fixture.scratch());
  const workspaceAt = (i: number): RepoRef => {
    const ws = workspaces[i];
    if (ws === undefined) throw new Error(`no workspace ${i}`);
    return ws;
  };
  const changes = [
    { "src/a.ts": "export const a = 10;\n" },
    { "lib/c.ts": "export const c = 3;\n" },
    { "docs/old.md": undefined },
    { "src/a.ts": "export const a = 20;\n" },
  ];
  const report = await run(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      const compose = (yield* CandidateComposer).compose;
      const commit = (yield* CodeHostFixture).commit;
      for (const repo of [staging, ...workspaces]) yield* codeHost.create(repo);
      const base = yield* commit(staging, MAIN, BASE);
      const heads: CommitSha[] = [];
      for (const [i, ws] of workspaces.entries()) {
        expect(yield* commit(ws, MAIN, BASE)).toBe(base);
        const files: Record<string, string> = { ...BASE };
        for (const [path, data] of Object.entries(changes[i] ?? {}))
          if (data === undefined) delete files[path];
          else files[path] = data;
        heads.push(yield* commit(ws, MAIN, files));
      }
      const member = (i: number) => ({
        changeId: changeId(i),
        repo: workspaceAt(i),
        base,
        head: heads[i] ?? base,
        // The first two are landings by an agent, one with a handle; the third keeps its submitted author.
        ...(i < 2
          ? { agent: { id: agentId(i), ...(i === 0 ? { handle: "k7f3-live" } : {}) } }
          : {}),
        title: `change ${i}`,
      });
      const request = {
        candidateId: candidateId(1),
        staging,
        base,
        at: AT,
        members: [0, 1, 2].map(member),
      };
      const started = Date.now();
      const composed = yield* compose(request);
      const ms = Date.now() - started;
      const pushedHead = yield* codeHost.head(staging, composed.ref);
      const again = yield* compose(request);
      const tree = (yield* codeHost.readTree(staging, composed.commitSha)).map((e) => e.path);
      const refused = yield* Effect.flip(
        compose({ ...request, candidateId: candidateId(2), members: [member(0), member(3)] }),
      );
      const refusedRef = yield* Effect.flip(
        codeHost.head(staging, `refs/heads/cand/${candidateId(2)}`),
      );
      return { base, heads, composed, ms, pushedHead, again, tree, refused, refusedRef };
    }),
  );
  const chain = await Promise.all(report.composed.commits.map((c) => readBack(staging, c.sha)));
  // What each agent pushed: a landing is authored by its agent at the pushed commit's date, and
  // declares the pushed author; a member with no agent keeps its author, as git rebase does.
  const submitted = await Promise.all(
    [0, 1, 2].map((i) => readBack(workspaceAt(i), report.heads[i] ?? report.base)),
  );
  const refusal = report.refused;
  console.log(
    `LIVE compose: ${report.composed.commits.length} commits in ${report.ms} ms, ref ${report.pushedHead === report.composed.commitSha ? "==" : "!="} last commit, again ${report.again.commitSha === report.composed.commitSha ? "same SHA" : "different SHA"}; chain ${JSON.stringify(chain.map((c) => ({ changeId: c.changeId, author: c.author, committer: c.committer })))}, submitted authors ${JSON.stringify(submitted.map((c) => c.author))}; conflicting batch ${refusal._tag} ${refusal.reason} ${JSON.stringify(refusal.paths)}, its ref ${report.refusedRef._tag}`,
  );
  expect(report.composed.commits).toHaveLength(3);
  expect(report.pushedHead).toBe(report.composed.commitSha);
  expect(report.again).toEqual(report.composed);
  expect(chain.map((c) => c.parents)).toEqual([
    [report.base],
    [report.composed.commits[0]?.sha],
    [report.composed.commits[1]?.sha],
  ]);
  const seconds = AT / 1000;
  // The pushed commits are not the agents' identities, so a composer keeping them fails here.
  expect(submitted.filter((c) => c.author.includes("@agents.keel.test"))).toEqual([]);
  const authors = [
    `k7f3-live <${agentId(0)}@agents.keel.test> ${submitted[0]?.authoredAt}`,
    `${agentId(1)} <${agentId(1)}@agents.keel.test> ${submitted[1]?.authoredAt}`,
    submitted[2]?.author,
  ];
  expect(chain).toEqual(
    [0, 1, 2].map((i) => ({
      parents: expect.any(Array),
      author: authors[i],
      authoredAt: submitted[i]?.authoredAt,
      committer: `Keel <keel@keel.test> ${seconds}`,
      changeId: changeId(i),
      agent: i < 2 ? agentId(i) : undefined,
      declared: i < 2 ? submitted[i]?.author.replace(/ \S+$/, "") : undefined,
      title: `change ${i}`,
    })),
  );
  expect(report.tree.toSorted()).toEqual(["README.md", "lib", "lib/c.ts", "src", "src/a.ts"]);
  expect(refusal).toMatchObject({
    _tag: "CompositionRefused",
    reason: "overlap",
    paths: ["src/a.ts"],
  });
  expect(report.refusedRef._tag).toBe("RefNotFound");
});

/** BASE plus a changelog with a line under Added and one under Fixed. */
const withChangelog = (added: string, fixed: string) => ({
  ...BASE,
  "CHANGELOG.md": `# Changelog\n\n## Unreleased\n\n### Added\n${added}\n### Fixed\n${fixed}\n## 0.1\n`,
});

/** A file of `lines` lines drawn from `vocab` distinct ones, by a fixed linear congruence. */
function lowVocabFile(vocab: number, bytes: number, seed: number): string[] {
  const lines: string[] = [];
  let state = seed;
  for (let n = 0; n < bytes;) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const line = `line ${state % vocab}\n`;
    lines.push(line);
    n += line.length;
  }
  return lines;
}

const encode = (ls: readonly string[]) => new TextEncoder().encode(ls.join(""));

/** Elapsed wall time across synchronous work: workerd's clock moves only at I/O, so it waits on a timer first. */
async function timed<A>(work: () => A): Promise<{ readonly result: A; readonly ms: number }> {
  const started = Date.now();
  const result = work();
  await new Promise((resolve) => setTimeout(resolve, 1));
  return { result, ms: Date.now() - started - 1 };
}

it("[composer.live-hunks] composes two changes to different parts of one file through the binding, and times a 2 MiB merge", async () => {
  const staging = fixture.fixture.scratch();
  const workspaces = [0, 1].map(() => fixture.fixture.scratch());
  const edits = [
    withChangelog("- added by change 0\n", ""),
    withChangelog("", "- fixed by change 1\n"),
  ];
  const report = await run(
    Effect.gen(function* () {
      const codeHost = yield* CodeHost;
      const compose = (yield* CandidateComposer).compose;
      const commit = (yield* CodeHostFixture).commit;
      for (const repo of [staging, ...workspaces]) yield* codeHost.create(repo);
      const base = yield* commit(staging, MAIN, withChangelog("", ""));
      const members = [];
      for (const [i, ws] of workspaces.entries()) {
        expect(yield* commit(ws, MAIN, withChangelog("", ""))).toBe(base);
        const head = yield* commit(ws, MAIN, edits[i] ?? {});
        members.push({ changeId: changeId(10 + i), repo: ws, base, head, title: `change ${i}` });
      }
      const composed = yield* compose({
        candidateId: candidateId(10),
        staging,
        base,
        at: AT,
        members,
      });
      const entries = yield* codeHost.readTree(staging, composed.commitSha);
      const log = entries.find((e) => e.path === "CHANGELOG.md");
      const bytes =
        log === undefined ? new Uint8Array(0) : yield* codeHost.readBlob(staging, log.oid);
      return { composed, changelog: new TextDecoder().decode(bytes) };
    }),
  );
  const timings: string[] = [];
  let worst = 0;
  for (const vocab of [3, 64, 1000]) {
    const lines = lowVocabFile(vocab, 2 * 1024 * 1024 - 256, vocab);
    const half = Math.floor(lines.length / 2);
    const ours = encode(lines.map((l, i) => (i % 9973 === 17 && i < half ? `ours ${i}\n` : l)));
    const theirs = encode(
      lines.map((l, i) => (i % 9973 === 17 && i >= half ? `theirs ${i}\n` : l)),
    );
    const { result, ms } = await timed(() =>
      mergeText(encode(lines), ours, theirs, new Budget(DIFF_BUDGET)),
    );
    worst = Math.max(worst, ms);
    timings.push(
      `vocab ${vocab} (${lines.length} lines): ${result.ok ? "merged" : result.reason} in ${ms} ms`,
    );
  }
  console.log(
    `LIVE compose by hunk: ${report.composed.commits.length} commits, candidate CHANGELOG.md ${JSON.stringify(report.changelog)}; 2 MiB mergeText in workerd: ${timings.join("; ")}; worst ${worst} ms`,
  );
  expect(report.composed.commits).toHaveLength(2);
  expect(report.changelog).toBe(
    withChangelog("- added by change 0\n", "- fixed by change 1\n")["CHANGELOG.md"],
  );
  expect(worst).toBeLessThan(5_000);
});
