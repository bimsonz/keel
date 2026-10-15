// A changed file as `git diff` prints it, written from Keel's hunks for the viewer that draws a patch. Nothing
// is read or guessed beyond what Keel's answer holds: its paths, its status and its lines.

import type { ChangedFile } from "../contract/diff.ts";

const MARK = { context: " ", add: "+", del: "-" } as const;

/** The file's unified patch: git's header for its status, then each hunk's range line and its lines. */
export function patchOf(file: ChangedFile): string {
  const from = file.previousPath ?? file.path;
  const head = [`diff --git a/${from} b/${file.path}`];
  if (file.status === "added") head.push("new file mode 100644");
  if (file.status === "deleted") head.push("deleted file mode 100644");
  if (file.status === "renamed") head.push(`rename from ${from}`, `rename to ${file.path}`);
  head.push(
    `--- ${file.status === "added" ? "/dev/null" : `a/${from}`}`,
    `+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}`,
  );
  const body = file.hunks.flatMap((hunk) => {
    // The range is Keel's numbers; whatever the header says after its second @@ is kept as git keeps it.
    const after = hunk.header.replace(/^@@[^@]*@@ ?/, "");
    const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    return [
      after === "" ? range : `${range} ${after}`,
      ...hunk.lines.map((line) => `${MARK[line.kind]}${line.text}`),
    ];
  });
  return `${[...head, ...body].join("\n")}\n`;
}

/** Large diffs are not drawn until asked for, as a code host leaves them: more lines changed than this. */
export const LARGE = 400;

/** Whether a file's diff waits to be asked for: Keel marked it too large, or it changes more lines than a page should draw at once. */
export function folded(file: ChangedFile): boolean {
  return file.tooLarge === true || file.additions + file.deletions > LARGE;
}
