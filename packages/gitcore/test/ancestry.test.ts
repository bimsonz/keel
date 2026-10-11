// gitcore's ancestry walk against git's own reachability: on generated
// histories with roots, merges and octopus merges, `isAncestor(a, d)` must
// answer exactly whether `git rev-list d` lists a. It drives a real git
// binary and fails, never skips, when git is missing. The walk's own limits
// (where it stops, how far it goes) have no git counterpart and are pinned
// on small in-memory histories.
//
// FC_NUM_RUNS sets the number of histories (60 by default: each spawns git
// once per commit) and FC_SEED pins them.

import { afterAll, describe, expect, it } from "vitest";
import { type CommitReader, isAncestor, MAX_ANCESTRY_WALK } from "../src/ancestry.ts";
import { MissingObject } from "../src/diff.ts";
import { CachingReader } from "../src/merge.ts";
import { CatFileReader, fastImport, git, tempRepo } from "./git-harness.ts";
import { fc } from "./support/fast-check.ts";

/** Histories per run; each spawns git once per commit, about half a second at load ~90. */
const RUNS = Number(process.env["FC_NUM_RUNS"] ?? 60);
const DEADLINE_MS = 60_000 + RUNS * 1000;

const repo = tempRepo();
const reader = new CatFileReader(repo.dir);
afterAll(() => {
  reader.close();
  repo.cleanup();
}, DEADLINE_MS);

/** Commit i's parents, by index, first parent first; commit 0 and any empty list is a root. */
const historyArb = fc
  .array(
    fc.oneof(
      { weight: 1, arbitrary: fc.constant<number[]>([]) },
      { weight: 9, arbitrary: fc.array(fc.nat(1000), { minLength: 1, maxLength: 3 }) },
    ),
    { minLength: 2, maxLength: 12 },
  )
  .map((picks) => picks.map((p, i) => (i === 0 ? [] : [...new Set(p.map((n) => n % i))])));

let caseId = 0;

/** Imports one history, each commit on a ref of its own; returns the commit ids by index. */
function imported(parents: readonly (readonly number[])[]): string[] {
  caseId += 1;
  const marks = fastImport(
    repo.dir,
    parents.map((ps, i) => ({
      mark: i + 1,
      ref: `refs/heads/h${caseId}/${i}`,
      parents: ps.map((p) => p + 1),
      tree: new Map([["f", { mode: "100644" as const, data: `${caseId}:${i}\n` }]]),
      message: `c${i}`,
    })),
  );
  return parents.map((_, i) => marks.get(i + 1) ?? "");
}

/** A history held in memory: commit ids are their indexes, and every read is counted. */
function memoryHistory(parents: Readonly<Record<string, readonly string[]>>) {
  const reads: string[] = [];
  const r: CommitReader = {
    readCommit: (oid) => {
      reads.push(oid);
      const found = parents[oid];
      return found === undefined
        ? Promise.reject(new MissingObject(oid))
        : Promise.resolve({ parents: found });
    },
  };
  return { r, reads };
}

describe("isAncestor", () => {
  it(
    "[ancestry.differential] answers exactly what git rev-list reaches, through every parent of every merge",
    async () => {
      const tally = { pairs: 0, reachable: 0, merges: 0 };
      await fc.assert(
        fc.asyncProperty(historyArb, async (parents) => {
          const ids = imported(parents);
          // One read per commit per history: the walks share what git already answered.
          const cached = new CachingReader(reader);
          tally.merges += parents.filter((ps) => ps.length > 1).length;
          for (const d of ids) {
            const reached = new Set(git(repo.dir, ["rev-list", d]).trim().split("\n"));
            for (const a of ids) {
              const answer = await isAncestor(cached, a, d);
              tally.pairs += 1;
              if (answer) tally.reachable += 1;
              if (answer !== reached.has(a))
                throw new Error(`isAncestor(${a}, ${d}) = ${answer}; git rev-list says ${!answer}`);
            }
          }
        }),
        { numRuns: RUNS },
      );
      console.log(
        `ancestry differential: ${tally.pairs} pairs, ${tally.reachable} reachable, ${tally.merges} merges, 0 wrong`,
      );
      expect(tally.merges).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );

  it("[ancestry.merge] reaches trunk's head through the second parent of an agent's merge", async () => {
    // base ← work, base ← trunk; merge = (work, trunk): the agent took trunk with `git merge FETCH_HEAD`.
    const { r } = memoryHistory({
      base: [],
      work: ["base"],
      trunk: ["base"],
      merge: ["work", "trunk"],
    });
    expect(await isAncestor(r, "trunk", "merge", { stopAt: ["base"] })).toBe(true);
    expect(await isAncestor(r, "work", "merge", { stopAt: ["base"] })).toBe(true);
    expect(await isAncestor(r, "trunk", "work")).toBe(false);
    expect(await isAncestor(r, "work", "trunk")).toBe(false);
    expect(await isAncestor(r, "base", "merge")).toBe(true);
    expect(await isAncestor(r, "merge", "merge")).toBe(true);
  });

  it("[ancestry.stop-at] never walks past a stop commit, but still finds it, and finds what another path reaches", async () => {
    // root ← base ← work; root ← side; merged = (work, side).
    const { r, reads } = memoryHistory({
      root: [],
      base: ["root"],
      work: ["base"],
      side: ["root"],
      merged: ["work", "side"],
    });
    expect(await isAncestor(r, "root", "work", { stopAt: ["base"] })).toBe(false);
    expect(reads).toEqual(["work", "base"]);
    expect(await isAncestor(r, "base", "work", { stopAt: ["base"] })).toBe(true);
    expect(await isAncestor(r, "root", "merged", { stopAt: ["base"] })).toBe(true);
    expect(await isAncestor(r, "root", "base", { stopAt: ["base"] })).toBe(false);
    expect(await isAncestor(r, "base", "base", { stopAt: ["base"] })).toBe(true);
  });

  it("[ancestry.bound] reads at most 10,000 commits, then answers false", async () => {
    let reads = 0;
    // An endless line: commit n's parent is n + 1.
    const endless: CommitReader = {
      readCommit: (oid) => {
        reads += 1;
        if (reads > MAX_ANCESTRY_WALK) throw new Error(`read ${reads} commits, past the bound`);
        return Promise.resolve({ parents: [String(Number(oid) + 1)] });
      },
    };
    expect(MAX_ANCESTRY_WALK).toBe(10_000);
    expect(await isAncestor(endless, "never", "0")).toBe(false);
    expect(reads).toBe(10_000);
    reads = 0;
    expect(await isAncestor(endless, "10", "0", { limit: 10 })).toBe(false);
    expect(reads).toBe(10);
    reads = 0;
    expect(await isAncestor(endless, "9", "0", { limit: 10 })).toBe(true);
  });

  it("[ancestry.missing] a commit the store lacks fails the walk with MissingObject", async () => {
    const { r } = memoryHistory({ work: ["gone"] });
    await expect(isAncestor(r, "other", "work")).rejects.toBeInstanceOf(MissingObject);
    await expect(isAncestor(r, "other", "nowhere")).rejects.toBeInstanceOf(MissingObject);
    // As git answers: a commit the store lacks is no answer, even when it is both ends.
    await expect(isAncestor(r, "nowhere", "nowhere")).rejects.toBeInstanceOf(MissingObject);
    expect(await isAncestor(r, "work", "work")).toBe(true);
  });
});
