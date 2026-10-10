// Check 1: GitCore's merged tree must equal `git merge-tree --write-tree`'s,
// or GitCore must refuse. A different tree, or a tree where git reports a
// conflict, is a failure.

import { writeFileSync } from "node:fs";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { mergeCommits, type SeededBug } from "../src/gitcore/merge";
import { CatFileReader, fastImport, gitMergeTree, tempRepo } from "./git-harness";
import { type History, historyArb, planCase } from "./gen";

const RUNS = Number(process.env.S13_RUNS ?? 3000);
const SEED = Number(process.env.S13_SEED ?? 1310);

const repo = tempRepo();
const reader = new CatFileReader(repo.dir);
afterAll(() => {
  reader.close();
  repo.cleanup();
});

let caseId = 0;

interface Stats {
  cases: number;
  identical: number;
  refused: number;
  byReason: Record<string, number>;
  gitConflicts: number;
  gitConflictsRefused: number;
  crissCross: number;
  cleanButRefused: number;
}

const blank = (): Stats => ({
  cases: 0,
  identical: 0,
  refused: 0,
  byReason: {},
  gitConflicts: 0,
  gitConflictsRefused: 0,
  crissCross: 0,
  cleanButRefused: 0,
});

async function runCase(h: History, bug: SeededBug | undefined, stats: Stats | null): Promise<string | null> {
  const plan = planCase(h, caseId++);
  const marks = fastImport(repo.dir, plan.commits);
  const ours = marks.get(plan.oursMark) as string;
  const theirs = marks.get(plan.theirsMark) as string;
  const g = gitMergeTree(repo.dir, ours, theirs);
  const r = await mergeCommits(reader, ours, theirs, { bug });
  if (stats) {
    stats.cases++;
    if (h.crissCross) stats.crissCross++;
    if (g.conflicted) stats.gitConflicts++;
  }
  if (!r.ok) {
    if (stats) {
      stats.refused++;
      stats.byReason[r.reason] = (stats.byReason[r.reason] ?? 0) + 1;
      if (g.conflicted) stats.gitConflictsRefused++;
      else stats.cleanButRefused++;
    }
    return null;
  }
  if (g.conflicted) return `git reported conflicts but GitCore produced ${r.tree}\n${g.output}`;
  if (r.tree !== g.tree) return `tree mismatch: GitCore ${r.tree} vs git ${g.tree}`;
  if (stats) stats.identical++;
  return null;
}

describe("differential: GitCore vs git merge-tree", () => {
  it(`is identical-or-refused over ${RUNS} generated histories`, async () => {
    const stats = blank();
    const t0 = Date.now();
    const out = await fc.check(
      fc.asyncProperty(historyArb, async (h) => {
        const err = await runCase(h, undefined, stats);
        if (err) throw new Error(err);
      }),
      { numRuns: RUNS, seed: SEED },
    );
    const summary = { seed: SEED, ...stats, ms: Date.now() - t0, failed: out.failed, catReads: reader.reads };
    console.log(`DIFFERENTIAL ${JSON.stringify(summary)}`);
    if (process.env.S13_OUT) writeFileSync(process.env.S13_OUT, JSON.stringify(summary, null, 2));
    if (out.failed) console.log(fc.defaultReportMessage(out));
    expect(out.failed).toBe(false);
    expect(stats.gitConflicts).toBe(stats.gitConflictsRefused);
  });

  for (const bug of ["ours-wins", "no-rename-guard"] as const) {
    it(`finds a counterexample when the "${bug}" bug is seeded`, async () => {
      const out = await fc.check(
        fc.asyncProperty(historyArb, async (h) => {
          const err = await runCase(h, bug, null);
          if (err) throw new Error(err);
        }),
        { numRuns: RUNS, seed: SEED },
      );
      console.log(`SEEDED ${bug}: failed=${out.failed} afterRuns=${out.numRuns} shrinks=${out.numShrinks}`);
      if (out.failed) {
        console.log(`SEEDED ${bug} counterexample: ${JSON.stringify(out.counterexample)}`);
        console.log(`SEEDED ${bug} error: ${String((out.errorInstance as Error | undefined)?.message).split("\n")[0]}`);
      }
      expect(out.failed).toBe(true);
    });
  }
});
