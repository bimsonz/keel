// gitcore's path-level merge against `git merge-tree --write-tree` on
// generated histories (spike S13's hostile mix: renames, mode and type
// changes, binaries, criss-cross bases). Every case is either the tree git
// writes, or a refusal; never another tree, and never a tree where git
// reports a conflict. It drives a real git binary and fails, never skips,
// when git is missing.
//
// FC_NUM_RUNS sets the number of histories (300 by default) and FC_SEED pins them.

import { afterAll, describe, expect, it } from "vitest";
import { mergeCommits, type MergeResult, type RefusalReason } from "../src/merge.ts";
import { type History, historyArb, planCase } from "./gen.ts";
import { CatFileReader, fastImport, gitMergeTree, tempRepo } from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";

/** Each history spawns git a few times: a second per case, so a machine at load ~230 still finishes 300 cases. */
const DEADLINE_MS = 60_000 + Number(process.env["FC_NUM_RUNS"] ?? 300) * 1000;

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

/** A merge's tree, or that it refused. */
const outcome = (m: MergeResult) => (m.ok ? m.tree : "refused");

interface Tally {
  cases: number;
  identical: number;
  refused: number;
  gitConflicts: number;
  gitCrashes: number;
  cleanButRefused: number;
  byReason: Partial<Record<RefusalReason, number>>;
}

const emptyTally = (): Tally => ({
  cases: 0,
  identical: 0,
  refused: 0,
  gitConflicts: 0,
  gitCrashes: 0,
  cleanButRefused: 0,
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
  if (git.outcome === "crashed")
    expect.fail(`git crashed (${git.signal}) but GitCore wrote ${merged.tree}`);
  expect(git.outcome, `git conflicted but GitCore wrote ${merged.tree}`).toBe("clean");
  expect(merged.tree).toBe(git.tree);
  tally.identical += 1;
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
        `MERGE-DIFFERENTIAL ${JSON.stringify({ seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
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
