// gitcore's diffTrees against `git diff-tree -r --no-renames` on generated
// histories, row for row: status, modes, ids and order, in both directions.
// It drives a real git binary and fails, never skips, when git is missing.
//
// FC_NUM_RUNS sets the number of histories (300 by default) and FC_SEED pins them.

import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { diffTrees, type TreeChange } from "../src/diff.ts";
import { historyArb, sides } from "./gen.ts";
import { CatFileReader, fastImport, GIT_ENV, tempRepo } from "./git-harness.ts";
import { fc } from "./support/fast-check.ts";

/** Each history spawns git a few times: a second per case, so a machine at load ~230 still finishes 300 cases. */
const DEADLINE_MS = 60_000 + Number(process.env["FC_NUM_RUNS"] ?? 300) * 1000;

const repo = tempRepo();
const reader = new CatFileReader(repo.dir);
// One pack per history: removing thousands of them outlasts vitest's 10 s hook default.
afterAll(() => {
  reader.close();
  repo.cleanup();
}, DEADLINE_MS);
const ZERO_MODE = "000000";
const STATUS: Record<string, TreeChange["change"]> = {
  A: "added",
  D: "deleted",
  M: "modified",
  T: "type-changed",
};

/** `git diff-tree -r -z` output as rows: ":<old mode> <new mode> <old id> <new id> <status>\0<path>\0" per change. */
function gitDiff(oldTree: string, newTree: string): TreeChange[] {
  const run = spawnSync("git", ["diff-tree", "-r", "-z", "--no-renames", oldTree, newTree], {
    cwd: repo.dir,
    env: GIT_ENV,
  });
  if (run.status !== 0)
    throw new Error(`git diff-tree failed (${run.status}): ${run.stderr.toString()}`);
  const fields = run.stdout.toString().split("\0");
  const rows: TreeChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode = "", newMode = "", oldOid = "", newOid = "", status = ""] = (fields[i] ?? "")
      .slice(1)
      .split(" ");
    const change = STATUS[status];
    if (change === undefined) throw new Error(`unexpected diff-tree status ${status}`);
    rows.push({
      path: fields[i + 1] ?? "",
      change,
      ...(oldMode === ZERO_MODE ? {} : { oldOid, oldMode }),
      ...(newMode === ZERO_MODE ? {} : { newOid, newMode }),
    });
  }
  return rows;
}

/** Field order differs between the two sides; compare rows on a fixed key order. */
const canonical = (rows: readonly TreeChange[]) =>
  rows.map((r) => [
    r.path,
    r.change,
    r.oldMode ?? null,
    r.oldOid ?? null,
    r.newMode ?? null,
    r.newOid ?? null,
  ]);

describe("diffTrees against git diff-tree -r", () => {
  it("has a git binary to compare against", () => {
    const version = spawnSync("git", ["--version"], { env: GIT_ENV });
    expect(version.status).toBe(0);
    expect(version.stdout.toString()).toMatch(/^git version \d+\.\d+/);
  });

  it(
    "[diff.differential] gives git's rows exactly, in both directions, on generated histories",
    async () => {
      const tally = { cases: 0, rows: 0, added: 0, deleted: 0, modified: 0, "type-changed": 0 };
      let id = 0;
      await fc.assert(
        fc.asyncProperty(historyArb, async (h) => {
          id += 1;
          const { a, b } = sides(h);
          const ref = (side: string) => `refs/heads/c${id}/${side}`;
          const marks = fastImport(repo.dir, [
            { mark: 1, ref: ref("a"), parents: [], tree: a, message: "a\n" },
            { mark: 2, ref: ref("b"), parents: [], tree: b, message: "b\n" },
          ]);
          const oldTree = (await reader.readCommit(marks.get(1) ?? "")).tree;
          const newTree = (await reader.readCommit(marks.get(2) ?? "")).tree;
          const forward = await diffTrees(reader, oldTree, newTree);
          expect(canonical(forward)).toEqual(canonical(gitDiff(oldTree, newTree)));
          expect(canonical(await diffTrees(reader, newTree, oldTree))).toEqual(
            canonical(gitDiff(newTree, oldTree)),
          );
          tally.cases += 1;
          tally.rows += forward.length;
          for (const row of forward) tally[row.change] += 1;
        }),
      );
      console.log(
        `DIFFERENTIAL ${JSON.stringify({ seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
      );
      expect(tally.cases).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );
});
