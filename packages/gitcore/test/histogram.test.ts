// gitcore's line diff against `git diff --histogram --no-indent-heuristic -U0`
// on generated file pairs, hunk for hunk: the scripts a three-way content
// merge reads. GitCore computes histogram as git did through 2.53, so there
// the scripts are equal. From 2.54 git re-diffs a group its compaction moved
// and slides what is left, so there every git hunk must lie inside the reach
// of a GitCore hunk, and git must pair the lines either side of every reach
// as GitCore does: together those make a merge GitCore accepts git's merge,
// byte for byte. It drives a real git binary and fails, never skips, when git
// is missing.
//
// FC_NUM_RUNS sets the number of pairs (300 by default) and FC_SEED pins them.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { enc } from "../src/bytes.ts";
import { diffLines, type Hunk, type Reach, type ReachingHunk, Unsure } from "../src/histogram.ts";
import { GIT_ENV, oracleGit } from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";
import { pairArb } from "./text-gen.ts";

/** One git spawn per pair: a second each leaves room at load ~230. */
const DEADLINE_MS = 60_000 + Number(process.env["FC_NUM_RUNS"] ?? 300) * 1000;

const oracle = oracleGit();
const scratch = mkdtempSync(join(tmpdir(), "gitcore-hist-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let pairId = 0;

/** A hunk header's start, 0-based: an empty range names the line before it. */
const startOf = (line = 0, len = 0) => (len === 0 ? line : line - 1);

/** git's hunks from `a` to `b`, from `@@ -l,s +l,s @@` headers (an empty range names the line before it). */
function gitHunks(a: Uint8Array, b: Uint8Array): Hunk[] {
  pairId += 1;
  const dir = join(scratch, String(pairId));
  mkdirSync(dir);
  writeFileSync(join(dir, "a"), a);
  writeFileSync(join(dir, "b"), b);
  const r = spawnSync(
    "git",
    ["diff", "--no-index", "--no-renames", "--histogram", "--no-indent-heuristic", "-U0", "a", "b"],
    { cwd: dir, env: GIT_ENV },
  );
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`git diff failed (${r.status}): ${r.stderr.toString()}`);
  const hunks: Hunk[] = [];
  for (const m of r.stdout
    .toString("latin1")
    .matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [aLine, aLen, bLine, bLen] = [m[1], m[2] ?? "1", m[3], m[4] ?? "1"].map(Number);
    hunks.push({
      a: startOf(aLine, aLen),
      aLen: aLen ?? 0,
      b: startOf(bLine, bLen),
      bLen: bLen ?? 0,
    });
  }
  return hunks;
}

const plain = ({ a, aLen, b, bLen }: Hunk): Hunk => ({ a, aLen, b, bLen });
const holds = (r: Reach, h: Hunk) =>
  h.a >= r.aFrom && h.a + h.aLen <= r.aTo && h.b >= r.bFrom && h.b + h.bLen <= r.bTo;

/** git's hunks that lie inside no reach of GitCore's, in base and side lines alike. */
const outside = (git: readonly Hunk[], ours: readonly ReachingHunk[]) =>
  git.filter((h) => !ours.some((o) => holds(o.reach, h)));

/** The reaches as regions: those that overlap or touch joined into one. */
function regions(ours: readonly ReachingHunk[]): Reach[] {
  const out: Reach[] = [];
  for (const r of ours
    .map((h) => h.reach)
    .toSorted((x, y) => x.aFrom - y.aFrom || x.bFrom - y.bFrom)) {
    const top = out.at(-1);
    if (top !== undefined && r.aFrom <= top.aTo)
      out[out.length - 1] = {
        aFrom: top.aFrom,
        bFrom: Math.min(top.bFrom, r.bFrom),
        aTo: Math.max(top.aTo, r.aTo),
        bTo: Math.max(top.bTo, r.bTo),
      };
    else out.push(r);
  }
  return out;
}

/**
 * The regions git's hunks grow or shrink by another amount than GitCore's:
 * past such a region git pairs a base line with another side line, and a
 * merge would write other bytes.
 */
const unpaired = (git: readonly Hunk[], ours: readonly ReachingHunk[]) =>
  regions(ours).filter(
    (r) =>
      git.filter((h) => holds(r, h)).reduce((n, h) => n + h.bLen - h.aLen, 0) !==
      r.bTo - r.bFrom - (r.aTo - r.aFrom),
  );

describe("diffLines", { timeout: PROPERTY_TIMEOUT }, () => {
  it(
    "[hunks.differential] gives git diff --histogram's hunks, file for file",
    () => {
      const tally = { pairs: 0, hunks: 0, reaching: 0, refused: 0, exact: 0, different: 0 };
      fc.assert(
        fc.property(pairArb, ({ a, b }) => {
          const ours = diffLines(a, b);
          tally.pairs += 1;
          if (ours instanceof Unsure) {
            tally.refused += 1;
            return;
          }
          tally.hunks += ours.length;
          tally.reaching += ours.filter((h) => h.reach.aTo - h.reach.aFrom > h.aLen).length;
          const git = gitHunks(a, b);
          if (JSON.stringify(git) === JSON.stringify(ours.map(plain))) tally.exact += 1;
          else tally.different += 1;
          // Through 2.53 the scripts are equal; from 2.54 git's hunks stay inside GitCore's reaches.
          expect(git).toEqual(oracle.rediffsMovedGroups ? git : ours.map(plain));
          expect(outside(git, ours), "git hunks outside every reach").toEqual([]);
          expect(unpaired(git, ours), "reaches git pairs past differently").toEqual([]);
        }),
      );
      console.log(
        `HUNKS-DIFFERENTIAL ${JSON.stringify({ git: oracle.version, seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
      );
      expect(tally.hunks).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );

  it("[hunks.rarer-anchor] keeps a rarer anchor over a longer run of commoner lines met later in b", () => {
    // R occurs once; A B C D twice. git anchors on R, so the run after it in b is not taken.
    const a = enc.encode("A\nB\nC\nD\nA\nB\nC\nD\nR\n");
    const b = enc.encode("R\nA\nB\nC\nD\n");
    expect(gitHunks(a, b)).toEqual([
      { a: 0, aLen: 8, b: 0, bLen: 0 },
      { a: 9, aLen: 0, b: 1, bLen: 4 },
    ]);
    const ours = diffLines(a, b);
    expect(ours instanceof Unsure ? ours : ours.map(plain)).toEqual(gitHunks(a, b));
  });

  it("[hunks.reach] a hunk compaction moved reaches over the lines git 2.54 re-matches; one it left alone, its span", () => {
    // Histogram anchors on `l2 l1` at the end, and compaction slides b's inserted group up to meet a's.
    const a = enc.encode("l2\nl1\nl2\nl2\nl1\n");
    const b = enc.encode("l2\nl2\nl2\nl0\r\nl2\nl1\n");
    const moved = diffLines(a, b);
    expect(moved).toEqual([
      { a: 0, aLen: 3, b: 0, bLen: 4, reach: { aFrom: 0, aTo: 5, bFrom: 0, bTo: 6 } },
    ]);
    // What git 2.55 answers: it deletes a[1] alone and inserts past the hunk, inside the reach.
    const git255: Hunk[] = [
      { a: 1, aLen: 1, b: 1, bLen: 0 },
      { a: 4, aLen: 0, b: 3, bLen: 2 },
    ];
    expect(gitHunks(a, b)).toEqual(
      oracle.rediffsMovedGroups ? git255 : moved instanceof Unsure ? [] : moved.map(plain),
    );
    expect(moved instanceof Unsure ? git255 : outside(git255, moved)).toEqual([]);

    // A changed line between equal neighbours has nowhere to slide: it reaches no further than itself.
    const still = diffLines(enc.encode("x\nx\ny\nx\nx\n"), enc.encode("x\nx\nz\nx\nx\n"));
    expect(still).toEqual([
      { a: 2, aLen: 1, b: 2, bLen: 1, reach: { aFrom: 2, aTo: 3, bFrom: 2, bTo: 3 } },
    ]);
  });

  it("[hunks.fallback] refuses a region whose common lines all occur more than 64 times, where git runs Myers", () => {
    const blank = "\n".repeat(70);
    const a = enc.encode(`x\n${blank}y\n`);
    const b = enc.encode(`${blank}z\n`);
    const ours = diffLines(a, b);
    expect(ours).toBeInstanceOf(Unsure);
    expect(ours instanceof Unsure && ours.why).toBe("diff-fallback");
  });
});
