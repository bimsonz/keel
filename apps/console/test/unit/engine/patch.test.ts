import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../../../src/contract/diff.ts";
import { LARGE, folded, patchOf } from "../../../src/engine/patch.ts";

const file = (over: Partial<ChangedFile> = {}): ChangedFile => ({
  path: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,3 +1,3 @@ function a()",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        { kind: "context", oldNumber: 1, newNumber: 1, text: "one" },
        { kind: "del", oldNumber: 2, text: "two" },
        { kind: "add", newNumber: 2, text: "TWO" },
        { kind: "context", oldNumber: 3, newNumber: 3, text: "three" },
      ],
    },
  ],
  ...over,
});

describe("a change's diff as a patch", () => {
  it("[patch.lines] writes each hunk under its range, a line each marked as kept, added or deleted, with the header's own words after the range", () => {
    expect(patchOf(file())).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@ function a()",
        " one",
        "-two",
        "+TWO",
        " three",
        "",
      ].join("\n"),
    );
  });

  it("[patch.status] says an added file came from nothing, a deleted one went to nothing, and a renamed one its old path", () => {
    const added = file({ status: "added", hunks: [] });
    expect(patchOf(added).split("\n").slice(1, 4)).toEqual([
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/a.ts",
    ]);
    const deleted = file({ status: "deleted", hunks: [] });
    expect(patchOf(deleted).split("\n").slice(1, 4)).toEqual([
      "deleted file mode 100644",
      "--- a/src/a.ts",
      "+++ /dev/null",
    ]);
    const renamed = file({ status: "renamed", previousPath: "src/old.ts", hunks: [] });
    expect(patchOf(renamed).split("\n").slice(0, 5)).toEqual([
      "diff --git a/src/old.ts b/src/a.ts",
      "rename from src/old.ts",
      "rename to src/a.ts",
      "--- a/src/old.ts",
      "+++ b/src/a.ts",
    ]);
  });

  it("[patch.folded] leaves a file Keel marked too large, or one past the line limit, to be asked for", () => {
    expect(folded(file())).toBe(false);
    expect(folded(file({ tooLarge: true, hunks: [] }))).toBe(true);
    expect(folded(file({ additions: LARGE, deletions: 1 }))).toBe(true);
    expect(folded(file({ additions: LARGE, deletions: 0 }))).toBe(false);
  });
});
