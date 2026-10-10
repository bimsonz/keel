import { afterAll, describe, expect, it } from "vitest";
import { enc } from "../src/bytes.ts";
import { encodeCommit, encodeTree, hashObject } from "../src/objects.ts";
import { git, tempRepo } from "./git-harness.ts";

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
    const viaGit = git(
      repo.dir,
      ["mktree", "--missing"],
      [
        `100644 blob ${blobOid}\ta0`,
        "040000 tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ta",
        `100755 blob ${blobOid}\ta.b`,
        `120000 blob ${blobOid}\tl`,
        "",
      ].join("\n"),
    ).trim();
    expect(await hashObject("tree", tree)).toBe(viaGit);

    const commit = encodeCommit({
      tree: viaGit,
      parents: [],
      author: { name: "t", email: "t@example.com", time: 1700000000 },
      committer: { name: "t", email: "t@example.com", time: 1700000000 },
      message: "subject\n\nbody",
      trailers: [["Change-Id", "I0123"]],
    });
    const viaGitCommit = git(repo.dir, [
      "commit-tree",
      viaGit,
      "-m",
      "subject\n\nbody\n\nChange-Id: I0123",
    ]).trim();
    expect(await hashObject("commit", commit)).toBe(viaGitCommit);
  });
});
