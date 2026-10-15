// A test fixture's change diff, written as whole files before and after, put in the shape Keel's
// `GET /v1/changes/{id}/diff` answers: per file its status, its counts and its unified hunks, three lines of
// context about each run of changes. Test code: the page reads Keel's own answer.

import type { ChangeDiff, ChangedFile, DiffHunk, DiffLine } from "../../../src/source/types.ts";

/** A fixture's diff as its scenario writes it: each file whole, before and after. */
export interface FixtureDiff {
  changeId: string;
  commit: string;
  files: { path: string; before: string | null; after: string | null }[];
  anchors: NonNullable<ChangeDiff["anchors"]>;
}

const CONTEXT = 3;

const linesOf = (text: string | null): string[] =>
  text === null || text === "" ? [] : text.replace(/\n$/, "").split("\n");

/** Every line of both sides in order, each kept, added or deleted: a longest common subsequence's walk. */
function walk(before: readonly string[], after: readonly string[]): DiffLine[] {
  const rows = before.length;
  const cols = after.length;
  const common: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols + 1 }, () => 0),
  );
  for (let i = rows - 1; i >= 0; i -= 1)
    for (let j = cols - 1; j >= 0; j -= 1)
      common[i]![j] =
        before[i] === after[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[i] === after[j]) {
      lines.push({ kind: "context", oldNumber: i + 1, newNumber: j + 1, text: before[i]! });
      i += 1;
      j += 1;
    } else if (j < cols && (i === rows || common[i]![j + 1]! >= common[i + 1]![j]!)) {
      lines.push({ kind: "add", newNumber: j + 1, text: after[j]! });
      j += 1;
    } else {
      lines.push({ kind: "del", oldNumber: i + 1, text: before[i]! });
      i += 1;
    }
  }
  return lines;
}

/** The walk cut into hunks: each run of changes with up to three unchanged lines either side. */
export function hunksOf(before: string | null, after: string | null): DiffHunk[] {
  const lines = walk(linesOf(before), linesOf(after));
  const changed = lines.flatMap((line, at) => (line.kind === "context" ? [] : [at]));
  const hunks: DiffHunk[] = [];
  let at = 0;
  while (at < changed.length) {
    const start = Math.max(0, changed[at]! - CONTEXT);
    let end = changed[at]!;
    while (at < changed.length && changed[at]! <= end + 2 * CONTEXT) {
      end = changed[at]!;
      at += 1;
    }
    const taken = lines.slice(start, Math.min(lines.length, end + CONTEXT + 1));
    const first = (side: "oldNumber" | "newNumber"): number =>
      taken.find((line) => line[side] !== undefined)?.[side] ?? 0;
    const oldLines = taken.filter((line) => line.kind !== "add").length;
    const newLines = taken.filter((line) => line.kind !== "del").length;
    const oldStart = oldLines === 0 ? 0 : first("oldNumber");
    const newStart = newLines === 0 ? 0 : first("newNumber");
    hunks.push({
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: taken,
    });
  }
  return hunks;
}

/** A fixture's diff as Keel answers one. */
export function wireDiffOf(diff: FixtureDiff): ChangeDiff {
  const files: ChangedFile[] = diff.files.map((file) => {
    const hunks = hunksOf(file.before, file.after);
    const all = hunks.flatMap((hunk) => hunk.lines);
    return {
      path: file.path,
      status: file.before === null ? "added" : file.after === null ? "deleted" : "modified",
      additions: all.filter((line) => line.kind === "add").length,
      deletions: all.filter((line) => line.kind === "del").length,
      hunks,
    };
  });
  return { files, anchors: diff.anchors };
}
