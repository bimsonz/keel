// gitcore's path-level merge against `git merge-tree --write-tree` on
// generated histories (spike S13's hostile mix: renames, mode and type
// changes, binaries, criss-cross bases). Every case is either the tree git
// writes, or a refusal; never another tree, and never a tree where git
// reports a conflict. It drives a real git binary and fails, never skips,
// when git is missing.
//
// FC_NUM_RUNS sets the number of histories (300 by default) and FC_SEED pins them.

import { afterAll, describe, expect, it } from "vitest";
import { dec } from "../src/bytes.ts";
import { mergeCommits, type MergeResult, type RefusalReason } from "../src/merge.ts";
import { type History, historyArb, planCase } from "./gen.ts";
import {
  CatFileReader,
  fastImport,
  gitMergeTree,
  oracleGit,
  git as runGit,
  tempRepo,
} from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";

/** Each history spawns git a few times: a second per case, so a machine at load ~230 still finishes 300 cases. */
const DEADLINE_MS = 60_000 + Number(process.env["FC_NUM_RUNS"] ?? 300) * 1000;

const oracle = oracleGit();
const repo = tempRepo();
const reader = new CatFileReader(repo.dir);
afterAll(() => {
  reader.close();
  repo.cleanup();
}, DEADLINE_MS);

let caseId = 0;

/** Imports one generated history and answers its two tips. */
function tipsOf(h: Parameters<typeof planCase>[0]) {
  caseId += 1;
  const plan = planCase(h, caseId);
  const marks = fastImport(repo.dir, plan.commits);
  return { ours: marks.get(plan.oursMark) ?? "", theirs: marks.get(plan.theirsMark) ?? "" };
}

const textTree = (files: Readonly<Record<string, string>>) =>
  new Map(Object.entries(files).map(([path, data]) => [path, { mode: "100644" as const, data }]));

/** Imports a base and two commits on it, each a set of text files, and answers the two. */
function onOneBase(
  base: Readonly<Record<string, string>>,
  ours: Readonly<Record<string, string>>,
  theirs: Readonly<Record<string, string>>,
) {
  caseId += 1;
  const ref = (name: string) => `refs/heads/fixed${caseId}/${name}`;
  const marks = fastImport(repo.dir, [
    { mark: 1, ref: ref("base"), parents: [], tree: textTree(base), message: "base\n" },
    { mark: 2, ref: ref("ours"), parents: [1], tree: textTree(ours), message: "ours\n" },
    { mark: 3, ref: ref("theirs"), parents: [1], tree: textTree(theirs), message: "theirs\n" },
  ]);
  return { ours: marks.get(2) ?? "", theirs: marks.get(3) ?? "" };
}

const FIVE = "1\n2\n3\n4\n5\n";
const textAuto = (f: string) => ({ "d/.gitattributes": "* text=auto\n", "d/f": f });

/** A merge's tree, or that it refused. */
const outcome = (m: MergeResult) => (m.ok ? m.tree : "refused");

interface Tally {
  cases: number;
  identical: number;
  refused: number;
  gitConflicts: number;
  gitCrashes: number;
  cleanButRefused: number;
  /** Merged with at least one file merged by hunk. */
  byHunk: number;
  byReason: Partial<Record<RefusalReason, number>>;
}

const emptyTally = (): Tally => ({
  cases: 0,
  identical: 0,
  refused: 0,
  gitConflicts: 0,
  gitCrashes: 0,
  cleanButRefused: 0,
  byHunk: 0,
  byReason: {},
});

/**
 * One history: GitCore writes git merge-tree's tree, or refuses; never another
 * tree. Where git crashes there is no tree to match, so GitCore must refuse.
 */
async function differential(h: History, tally: Tally): Promise<void> {
  const { ours, theirs } = tipsOf(h);
  const git = gitMergeTree(repo.dir, ours, theirs);
  const merged = await mergeCommits(reader, ours, theirs);
  tally.cases += 1;
  if (git.outcome === "conflicted") tally.gitConflicts += 1;
  if (git.outcome === "crashed") tally.gitCrashes += 1;
  if (!merged.ok) {
    tally.refused += 1;
    tally.byReason[merged.reason] = (tally.byReason[merged.reason] ?? 0) + 1;
    if (git.outcome === "clean") tally.cleanButRefused += 1;
    return;
  }
  const answer = git.outcome === "crashed" ? `crashed (${git.signal})` : git.outcome;
  expect(answer, `git ${answer} but GitCore wrote ${merged.tree}`).toBe("clean");
  expect(merged.tree).toBe(git.outcome === "crashed" ? undefined : git.tree);
  tally.identical += 1;
  if ([...merged.newObjects.values()].some((o) => o.type === "blob")) tally.byHunk += 1;
}

/**
 * Histories the generator once failed on, kept as fixed cases with the answer
 * GitCore must give: `refused` names the guard that has to stop it.
 */
const COUNTEREXAMPLES: readonly {
  readonly name: string;
  readonly history: History;
  readonly refused: RefusalReason;
}[] = [
  {
    // One merge base adds a gitlink at b/z and ours turns it into a
    // symlink. git 2.50's merge-tree aborts on it (see GitMerge's `crashed`), so only a refusal is right.
    name: "criss-cross, gitlink then symlink at one path",
    refused: "criss-cross",
    history: {
      base: [
        { path: "a", lines: [0, 0, 0, 0] },
        { path: "x", lines: [0, 0, 0, 0] },
      ],
      shared: [{ k: "gitlink", path: "z", sha: "1111111111111111111111111111111111111111" }],
      ours: [{ k: "symlink", path: "b/z", target: "x" }],
      theirs: [],
      crissCross: {
        a: [{ k: "gitlink", path: "b/z", sha: "1111111111111111111111111111111111111111" }],
        c: [{ k: "chmod", pick: 0 }],
      },
    },
  },
];

describe("mergeCommits", { timeout: PROPERTY_TIMEOUT }, () => {
  it(
    "[merge.differential] writes git merge-tree's tree or refuses, on generated histories",
    async () => {
      const tally = emptyTally();
      await fc.assert(fc.asyncProperty(historyArb, (h) => differential(h, tally)));
      console.log(
        `MERGE-DIFFERENTIAL ${JSON.stringify({ git: oracle.version, seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
      );
      expect(tally.identical).toBeGreaterThan(0);
      expect(tally.identical + tally.refused).toBe(tally.cases);
    },
    DEADLINE_MS,
  );

  it.each(COUNTEREXAMPLES)(
    "[merge.counterexample] $name: refused as $refused",
    async ({ history, refused }) => {
      const tally = emptyTally();
      await differential(history, tally);
      expect(tally.byReason).toEqual({ [refused]: 1 });
    },
  );

  it("[merge.content-blob] merges one file both sides changed apart, as git does, and hands back the merged blob", async () => {
    const { ours, theirs } = onOneBase(
      { "a/f": FIVE, g: "g\n" },
      { "a/f": "one\n2\n3\n4\n5\n", g: "g\n" },
      { "a/f": "1\n2\n3\n4\nfive\n", g: "g\n" },
    );
    const merged = await mergeCommits(reader, ours, theirs);
    const byGit = gitMergeTree(repo.dir, ours, theirs);
    expect(byGit.outcome).toBe("clean");
    expect(merged.ok && merged.tree).toBe(byGit.outcome === "clean" && byGit.tree);
    const blobs = [...(merged.ok ? merged.newObjects.values() : [])].filter(
      (o) => o.type === "blob",
    );
    expect(blobs.map((o) => dec.decode(o.body))).toEqual(["one\n2\n3\n4\nfive\n"]);
  });

  it.each([
    ["* merge=union", "* merge=union\n"],
    ["a path unset -merge", "f -merge\n"],
    ["the binary macro", "f binary\n"],
    ["a macro that unsets merge", "[attr]keep -merge\nf keep\n"],
  ])(
    "[merge.attributes] refuses a content merge under a .gitattributes with %s",
    async (_what, rules) => {
      const at = (f: string) => ({ ".gitattributes": rules, "d/.keep": "", "d/f": f });
      const { ours, theirs } = onOneBase(
        at(FIVE),
        at("one\n2\n3\n4\n5\n"),
        at("1\n2\n3\n4\nfive\n"),
      );
      expect(await mergeCommits(reader, ours, theirs)).toEqual({
        ok: false,
        reason: "attributes",
        path: "d/f",
      });
    },
  );

  it("[merge.attributes] merges under a .gitattributes that names no merge driver, as git does", async () => {
    const { ours, theirs } = onOneBase(
      textAuto(FIVE),
      textAuto("one\n2\n3\n4\n5\n"),
      textAuto("1\n2\n3\n4\nfive\n"),
    );
    const merged = await mergeCommits(reader, ours, theirs);
    const byGit = gitMergeTree(repo.dir, ours, theirs);
    expect(merged.ok && merged.tree).toBe(byGit.outcome === "clean" && byGit.tree);
    expect(runGit(repo.dir, ["cat-file", "-p", `${merged.ok ? merged.tree : ""}:d/f`])).toBe(
      "one\n2\n3\n4\nfive\n",
    );
  });

  it(
    "[merge.symmetric] merging theirs into ours gives the same tree, or the same refusal, as ours into theirs",
    async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, async (h) => {
          const { ours, theirs } = tipsOf(h);
          const forward = await mergeCommits(reader, ours, theirs);
          const backward = await mergeCommits(reader, theirs, ours);
          expect(outcome(backward)).toBe(outcome(forward));
        }),
      );
    },
    DEADLINE_MS,
  );
});
