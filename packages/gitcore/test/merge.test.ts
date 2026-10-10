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
import { historyArb, planCase } from "./gen.ts";
import { CatFileReader, fastImport, gitMergeTree, tempRepo } from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";

/** Each history spawns git a few times; give every case a generous share of the deadline. */
const DEADLINE_MS = 60_000 + Number(process.env["FC_NUM_RUNS"] ?? 300) * 250;

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

describe("mergeCommits", { timeout: PROPERTY_TIMEOUT }, () => {
  it(
    "[merge.differential] writes git merge-tree's tree or refuses, on generated histories",
    async () => {
      const tally = {
        cases: 0,
        identical: 0,
        refused: 0,
        gitConflicts: 0,
        cleanButRefused: 0,
        byReason: {} as Partial<Record<RefusalReason, number>>,
      };
      await fc.assert(
        fc.asyncProperty(historyArb, async (h) => {
          const { ours, theirs } = tipsOf(h);
          const git = gitMergeTree(repo.dir, ours, theirs);
          const merged = await mergeCommits(reader, ours, theirs);
          tally.cases += 1;
          if (git.conflicted) tally.gitConflicts += 1;
          if (!merged.ok) {
            tally.refused += 1;
            tally.byReason[merged.reason] = (tally.byReason[merged.reason] ?? 0) + 1;
            if (!git.conflicted) tally.cleanButRefused += 1;
            return;
          }
          expect(git.conflicted, `git conflicted but GitCore wrote ${merged.tree}`).toBe(false);
          expect(merged.tree).toBe(git.tree);
          tally.identical += 1;
        }),
      );
      console.log(
        `MERGE-DIFFERENTIAL ${JSON.stringify({ seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
      );
      expect(tally.identical).toBeGreaterThan(0);
      expect(tally.identical + tally.refused).toBe(tally.cases);
    },
    DEADLINE_MS,
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
