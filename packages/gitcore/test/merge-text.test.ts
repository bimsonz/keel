// gitcore's three-way text merge against `git merge-file -p
// --diff-algorithm=histogram` on generated files: wherever GitCore merges,
// its bytes are git's, and wherever git conflicts, GitCore refuses. It may
// refuse more than git (the tally counts those), never less. It drives a real
// git binary and fails, never skips, when git is missing.
//
// FC_NUM_RUNS sets the number of cases (300 by default) and FC_SEED pins them.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { enc, toHex } from "../src/bytes.ts";
import { diffLines, type Hunk, Unsure } from "../src/histogram.ts";
import { mergeText, type TextRefusal } from "../src/merge-text.ts";
import { GIT_ENV, oracleGit } from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";
import { changelogArb, threeWayArb } from "./text-gen.ts";

/** One git spawn per case: a second each leaves room at load ~230. */
const DEADLINE_MS = 60_000 + Number(process.env["FC_NUM_RUNS"] ?? 300) * 1000;

const oracle = oracleGit();
const scratch = mkdtempSync(join(tmpdir(), "gitcore-merge-file-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let caseId = 0;

/** git merge-file's merged bytes, or that it conflicted. */
function gitMergeFile(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
): { readonly clean: true; readonly merged: Uint8Array } | { readonly clean: false } {
  caseId += 1;
  const dir = join(scratch, String(caseId));
  mkdirSync(dir);
  writeFileSync(join(dir, "base"), base);
  writeFileSync(join(dir, "ours"), ours);
  writeFileSync(join(dir, "theirs"), theirs);
  const r = spawnSync(
    "git",
    ["merge-file", "-p", "--diff-algorithm=histogram", "ours", "base", "theirs"],
    { cwd: dir, env: GIT_ENV },
  );
  rmSync(dir, { recursive: true, force: true });
  if (r.status === null || r.status < 0 || r.status > 127)
    throw new Error(`git merge-file failed (${r.status}): ${r.stderr.toString()}`);
  return r.status === 0 ? { clean: true, merged: new Uint8Array(r.stdout) } : { clean: false };
}

const blanks = (n: number) => "\n".repeat(n);

const clear = (x: Hunk, y: Hunk) => x.a + x.aLen < y.a || y.a + y.aLen < x.a;

/** Whether the hunks themselves are parted by a base line: what merged before hunks had reaches. */
function spansParted(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): boolean {
  const [o, t] = [diffLines(base, ours), diffLines(base, theirs)];
  if (o instanceof Unsure || t instanceof Unsure) return false;
  return o.every((x) => t.every((y) => clear(x, y)));
}

/** forge-lite's package.json with an author line near its top and a keywords line near its end, either empty. */
const manifest = (author: string, keywords: string) =>
  enc.encode(
    `{\n${author}  "name": "forge-lite",\n  "version": "0.0.0",\n  "private": true,\n  "license": "MIT",\n${keywords}  "type": "module",\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n`,
  );

describe("mergeText", { timeout: PROPERTY_TIMEOUT }, () => {
  it(
    "[mergetext.differential] writes git merge-file's bytes or refuses; never merges where git conflicts",
    () => {
      const tally = {
        cases: 0,
        merged: 0,
        refused: 0,
        gitConflicts: 0,
        gitCleanButRefused: 0,
        refusedByReachAlone: 0,
        byReason: {} as Partial<Record<TextRefusal, number>>,
      };
      fc.assert(
        fc.property(threeWayArb, ({ base, ours, theirs }) => {
          const git = gitMergeFile(base, ours, theirs);
          const merged = mergeText(base, ours, theirs);
          tally.cases += 1;
          if (!git.clean) tally.gitConflicts += 1;
          if (!merged.ok) {
            tally.refused += 1;
            tally.byReason[merged.reason] = (tally.byReason[merged.reason] ?? 0) + 1;
            if (git.clean) tally.gitCleanButRefused += 1;
            if (git.clean && spansParted(base, ours, theirs)) tally.refusedByReachAlone += 1;
            return;
          }
          expect(toHex(merged.merged), "GitCore merged where git conflicts").toBe(
            git.clean ? toHex(git.merged) : "git conflicted",
          );
          tally.merged += 1;
        }),
      );
      console.log(
        `MERGETEXT-DIFFERENTIAL ${JSON.stringify({ git: oracle.version, seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
      );
      expect(tally.merged).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );

  it("[hunks.rediff-shifted] refuses hunks that touch as git merged through 2.53, though 2.54 on merges them", () => {
    // Ours deletes l1. Histogram then compaction (git through 2.53, and GitCore) replaces `l1 l0` with
    // `l0`, a hunk touching theirs' line; from 2.54 git re-diffs that moved group to delete l1 alone.
    const base = enc.encode("l0\nl1\nl0\nl0\nl0\n");
    const ours = enc.encode("l0\nl0\nl0\nl0\n");
    const theirs = enc.encode("l0\nl1\nl0\nt\nl0\n");
    expect(gitMergeFile(base, ours, theirs).clean).toBe(oracle.rediffsMovedGroups);
    expect(mergeText(base, ours, theirs)).toEqual({ ok: false, reason: "overlap" });
  });

  it("[hunks.rediff-reach] refuses a change inside a moved hunk's reach, which git from 2.54 conflicts on though git through 2.53 merges", () => {
    // Ours rewrites `l0\r` and inserts an l1. Histogram then compaction (git through 2.53, and GitCore) change
    // base lines 0 to 2, a line clear of theirs' line 4; from 2.54 git re-diffs that moved group and what is left
    // of it slides down to touch line 4. The hunk's reach holds every line it could slide over, so GitCore refuses.
    const base = enc.encode("l0\r\nl1\nl2\nl1\nl2\nl1\nl2\n");
    const ours = enc.encode("l0\nl1\nl2\nl1\nl1\nl2\nl1\nl2\n");
    const theirs = enc.encode("l0\r\nl1\nl2\nl1\nt\nl1\nl2\n");
    expect(gitMergeFile(base, ours, theirs).clean).toBe(!oracle.rediffsMovedGroups);
    expect(mergeText(base, ours, theirs)).toEqual({ ok: false, reason: "overlap" });
  });

  it(
    "[mergetext.changelog] merges two appends to different sections of a changelog, every one, as git does",
    () => {
      const tally = { cases: 0, merged: 0, refused: 0 };
      fc.assert(
        fc.property(changelogArb, ({ base, ours, theirs, both }) => {
          const git = gitMergeFile(base, ours, theirs);
          const merged = mergeText(base, ours, theirs);
          tally.cases += 1;
          if (merged.ok) tally.merged += 1;
          else tally.refused += 1;
          expect(git.clean && toHex(git.merged)).toBe(toHex(both));
          expect(merged.ok ? toHex(merged.merged) : merged.reason).toBe(toHex(both));
        }),
      );
      console.log(
        `MERGETEXT-CHANGELOG ${JSON.stringify({ git: oracle.version, seed: process.env["FC_SEED"] ?? "fresh", ...tally })}`,
      );
    },
    DEADLINE_MS,
  );

  it("[mergetext.manifest] merges two keys added to different parts of a package.json", () => {
    const [author, keywords] = ['  "author": "second",\n', '  "keywords": ["first"],\n'];
    const merged = mergeText(manifest("", ""), manifest("", keywords), manifest(author, ""));
    expect(merged.ok && toHex(merged.merged)).toBe(toHex(manifest(author, keywords)));
    const git = gitMergeFile(manifest("", ""), manifest("", keywords), manifest(author, ""));
    expect(git.clean && toHex(git.merged)).toBe(toHex(manifest(author, keywords)));
  });

  it("[mergetext.fallback] refuses where git's histogram falls back to Myers, though git merges", () => {
    const base = enc.encode(`${blanks(70)}mid\n${blanks(70)}`);
    // 66 blank lines, then a new line: the region left of `mid` holds only a line seen 66 times.
    const ours = enc.encode(`${blanks(66)}o\n${blanks(4)}mid\n${blanks(70)}`);
    const theirs = enc.encode(`${blanks(70)}mid\n${blanks(69)}t\n`);
    expect(gitMergeFile(base, ours, theirs).clean).toBe(true);
    expect(mergeText(base, ours, theirs)).toEqual({ ok: false, reason: "diff-fallback" });
  });

  it("[mergetext.too-large] refuses a version over 2 MiB", () => {
    const big = enc.encode("x\n".repeat(1024 * 1024 + 1));
    const small = enc.encode("x\n");
    expect(mergeText(small, big, small)).toEqual({ ok: false, reason: "too-large" });
  });
});
