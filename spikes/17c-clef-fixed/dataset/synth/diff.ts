// Minimal unified diff for the synthetic items: LCS over lines, hunks with a
// fixed number of context lines, adjacent hunks merged. Output uses the same
// "--- a/x / +++ b/x / @@" layout as the hand-written diffs, so it goes through
// the same parser (which recomputes the @@ counts).

export function unifiedDiff(path: string, before: string | null, after: string | null, context = 5): string {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === null ? [] : after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { tag: " " | "-" | "+"; text: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ tag: " ", text: a[i], ai: i++, bi: j++ });
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ tag: "-", text: a[i], ai: i++, bi: j });
    } else {
      ops.push({ tag: "+", text: b[j], ai: i, bi: j++ });
    }
  }
  const changed = ops.map((o, k) => (o.tag === " " ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) throw new Error(`${path}: no change`);
  const ranges: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length - 1, k + context);
    const last = ranges.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  const out = [before === null ? "--- /dev/null" : `--- a/${path}`, after === null ? "+++ /dev/null" : `+++ b/${path}`];
  for (const [lo, hi] of ranges) {
    const first = ops[lo];
    out.push(`@@ -${before === null ? 0 : first.ai + 1} +${after === null ? 0 : first.bi + 1} @@`);
    for (let k = lo; k <= hi; k++) out.push(ops[k].tag + ops[k].text);
  }
  return out.join("\n") + "\n";
}
