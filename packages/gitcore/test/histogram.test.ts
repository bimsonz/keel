// gitcore's line diff against `git diff --histogram --no-indent-heuristic -U0`
// on generated file pairs, hunk for hunk: the scripts a three-way content
// merge reads. It drives a real git binary and fails, never skips, when git
// is missing.
//
// FC_NUM_RUNS sets the number of pairs (300 by default) and FC_SEED pins them.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { enc } from "../src/bytes.ts";
import { diffLines, type Hunk, Unsure } from "../src/histogram.ts";
import { GIT_ENV } from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";
import { pairArb } from "./text-gen.ts";

/** One git spawn per pair: a second each leaves room at load ~230. */
const DEADLINE_MS = 60_000 + Number(process.env["FC_NUM_RUNS"] ?? 300) * 1000;

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

describe("diffLines", { timeout: PROPERTY_TIMEOUT }, () => {
  it(
    "[hunks.differential] gives git diff --histogram's hunks, file for file",
    () => {
      const tally = { pairs: 0, hunks: 0, refused: 0 };
      fc.assert(
        fc.property(pairArb, ({ a, b }) => {
          const ours = diffLines(a, b);
          tally.pairs += 1;
          if (ours instanceof Unsure) {
            tally.refused += 1;
            return;
          }
          tally.hunks += ours.length;
          expect(ours).toEqual(gitHunks(a, b));
        }),
      );
      console.log(
        `HUNKS-DIFFERENTIAL ${JSON.stringify({ seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
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
    expect(diffLines(a, b)).toEqual(gitHunks(a, b));
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
