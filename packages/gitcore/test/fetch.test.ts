// The relay against real git: fetches go to `git upload-pack --stateless-rpc`
// on a source bare repo, and pushes to `git receive-pack --stateless-rpc` on a
// target, as Keel's sync copies trunk into staging and the mirror.

import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { PackTooLarge, relay, uploadPack } from "../src/fetch.ts";
import type { GitRemote } from "../src/push.ts";
import { git, GIT_ENV, smartHttp, tempRepo } from "./git-harness.ts";
import { PROPERTY_TIMEOUT } from "./support/fast-check.ts";

const repos = { source: tempRepo(), target: tempRepo() };
afterAll(() => {
  repos.source.cleanup();
  repos.target.cleanup();
});

const http = smartHttp({ source: repos.source.dir, target: repos.target.dir });
const remoteOf = (name: string): GitRemote => ({
  url: `https://git.invalid/${name}`,
  token: "unused",
  fetch: http.fetch,
});
const source = remoteOf("source");
const target = remoteOf("target");
const MAIN = "refs/heads/main";

/** Commits one file on top of `parent` in `dir` and moves main there. */
function commitFile(dir: string, path: string, content: string, parent?: string): string {
  const blob = git(dir, ["hash-object", "-w", "--stdin"], content).trim();
  const tree = git(dir, ["mktree"], `100644 blob ${blob}\t${path}\n`).trim();
  const sha = git(dir, [
    "commit-tree",
    ...(parent === undefined ? [] : ["-p", parent]),
    "-m",
    `${path}: ${content.length} bytes`,
    tree,
  ]).trim();
  git(dir, ["update-ref", MAIN, sha]);
  return sha;
}

const headOf = (dir: string): string | null => {
  const run = spawnSync("git", ["rev-parse", "--verify", "-q", MAIN], { cwd: dir, env: GIT_ENV });
  return run.status === 0 ? run.stdout.toString().trim() : null;
};

/** The target holds every object the commit reaches, not just the ref. */
const connected = (dir: string, sha: string) =>
  spawnSync("git", ["rev-list", "--objects", "--missing=print", sha], { cwd: dir, env: GIT_ENV })
    .stdout.toString()
    .split("\n")
    .filter((line) => line.startsWith("?"));

describe("relay", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[sync.empty-then-advance] copies trunk into an empty repo, then each new head after it", async () => {
    const first = commitFile(repos.source.dir, "a.txt", "one\n");
    expect(headOf(repos.target.dir)).toBeNull();
    expect(await relay(source, target, { ref: MAIN, from: null, to: first })).toEqual({
      kind: "advanced",
    });
    expect(headOf(repos.target.dir)).toBe(first);
    expect(connected(repos.target.dir, first)).toEqual([]);

    const second = commitFile(repos.source.dir, "a.txt", "two\n", first);
    expect(await relay(source, target, { ref: MAIN, from: first, to: second })).toEqual({
      kind: "advanced",
    });
    expect(headOf(repos.target.dir)).toBe(second);
    expect(connected(repos.target.dir, second)).toEqual([]);
  });

  it("[sync.idempotent] a target already at the source's head is left alone, with nothing sent", async () => {
    const head = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "idem\n");
    if (headOf(repos.target.dir) !== head)
      await relay(source, target, { ref: MAIN, from: headOf(repos.target.dir), to: head });
    const before = http.served.requests;
    expect(await relay(source, target, { ref: MAIN, from: head, to: head })).toEqual({
      kind: "unchanged",
    });
    expect(http.served.requests).toBe(before);
    expect(headOf(repos.target.dir)).toBe(head);
  });

  it("[sync.stale] a target that moved since it was read refuses the relay and keeps its head", async () => {
    const base = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "base\n");
    if (headOf(repos.target.dir) !== base)
      await relay(source, target, { ref: MAIN, from: headOf(repos.target.dir), to: base });
    const elsewhere = commitFile(repos.target.dir, "b.txt", "moved meanwhile\n", base);
    const next = commitFile(repos.source.dir, "a.txt", "next\n", base);
    const outcome = await relay(source, target, { ref: MAIN, from: base, to: next });
    expect(outcome.kind).toBe("rejected");
    expect(headOf(repos.target.dir)).toBe(elsewhere);
  });

  it("[sync.too-large] a pack over the cap fails loudly and pushes nothing", async () => {
    const before = headOf(repos.target.dir);
    const big = commitFile(
      repos.source.dir,
      "big.txt",
      "x".repeat(4096),
      headOf(repos.source.dir) ?? undefined,
    );
    await expect(
      relay(source, target, { ref: MAIN, from: before, to: big }, { maxPackBytes: 64 }),
    ).rejects.toBeInstanceOf(PackTooLarge);
    expect(headOf(repos.target.dir)).toBe(before);
  });

  it("[sync.upload-pack] fetches only what the haves lack", async () => {
    const base = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    const tip = commitFile(repos.source.dir, "c.txt", "tip only\n", base);
    const whole = await uploadPack(source, [tip], []);
    const delta = await uploadPack(source, [tip], [base]);
    const count = (pack: Uint8Array) => new DataView(pack.buffer, pack.byteOffset).getUint32(8);
    // tip's commit, tree and blob; the whole history holds more.
    expect(count(delta)).toBe(3);
    expect(count(whole)).toBeGreaterThan(count(delta));
  });
});
