import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { enc } from "../src/gitcore/bytes";
import { encodeCommit, encodeTree, hashObject } from "../src/gitcore/objects";
import { readPack } from "../src/gitcore/pack-read";
import { writePack } from "../src/gitcore/pack-write";
import { GIT_ENV, git, tempRepo } from "./git-harness";

const repo = tempRepo();
afterAll(() => repo.cleanup());

describe("object format", () => {
  it("blob, tree and commit ids match git", async () => {
    const blob = enc.encode("hello\n");
    const blobOid = git(repo.dir, ["hash-object", "-w", "--stdin"], blob).trim();
    expect(await hashObject("blob", blob)).toBe(blobOid);

    // Canonical order: "a.b" < "a" (as tree, "a/") < "a0"; supplied out of order on purpose.
    const tree = encodeTree([
      { name: "a0", mode: "100644", oid: blobOid },
      { name: "a", mode: "40000", oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" },
      { name: "a.b", mode: "100755", oid: blobOid },
      { name: "l", mode: "120000", oid: blobOid },
    ]);
    git(repo.dir, ["hash-object", "-w", "-t", "tree", "--stdin"], new Uint8Array(0));
    const viaGit = git(repo.dir, ["mktree", "--missing"], [
      `100644 blob ${blobOid}\ta0`,
      "040000 tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ta",
      `100755 blob ${blobOid}\ta.b`,
      `120000 blob ${blobOid}\tl`,
      "",
    ].join("\n")).trim();
    expect(await hashObject("tree", tree)).toBe(viaGit);

    const commit = encodeCommit({
      tree: viaGit,
      parents: [],
      author: { name: "t", email: "t@example.com", time: 1700000000 },
      committer: { name: "t", email: "t@example.com", time: 1700000000 },
      message: "subject\n\nbody",
      trailers: [["Change-Id", "I0123"]],
    });
    const viaGitCommit = git(repo.dir, ["commit-tree", viaGit, "-m", "subject\n\nbody\n\nChange-Id: I0123"]).trim();
    expect(await hashObject("commit", commit)).toBe(viaGitCommit);
  });
});

describe("pack v2", () => {
  it("writer output is accepted by git index-pack", async () => {
    const blob = enc.encode("packed\n");
    const tree = encodeTree([{ name: "f", mode: "100644", oid: await hashObject("blob", blob) }]);
    const pack = await writePack([
      { type: "blob", body: blob },
      { type: "tree", body: tree },
    ]);
    const path = join(repo.dir, "test.pack");
    writeFileSync(path, pack);
    const r = spawnSync("git", ["index-pack", "--strict", path], { cwd: repo.dir, env: GIT_ENV });
    expect(r.stderr.toString()).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reader verifies every object of a git-built pack with deltas", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const oids = [0, 1, 2, 3].map((v) =>
      git(repo.dir, ["hash-object", "-w", "--stdin"], `${lines}\nversion ${v}\n`).trim(),
    );
    const r = spawnSync("git", ["pack-objects", "--stdout"], { cwd: repo.dir, env: GIT_ENV, input: `${oids.join("\n")}\n` });
    const pack = new Uint8Array(r.stdout);
    const out = await readPack(pack);
    expect(out.trailerOk).toBe(true);
    expect(out.objects.length).toBe(out.declaredCount);
    expect(out.deltas).toBeGreaterThan(0);
    expect(new Set(out.objects.map((o) => o.oid))).toEqual(new Set(oids));
  });
});

