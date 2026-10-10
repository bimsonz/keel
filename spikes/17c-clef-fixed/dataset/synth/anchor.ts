// Fix 3 for synthetic items: the anchor view. Clef sees the complete code of
// the premise's anchors, before and after, as a diff with full context, and
// nothing else: no sibling symbol, no unrelated symbol. An anchor the change
// leaves untouched is shown as context only (the code it already has), which
// is what an adapter with the repository would send.
//
// Which code is the subject's comes from the renderer, which knows every
// block's symbol, standing in for a correct anchor registry:
//   subject  the family's anchor, and every symbol whose code depends on the
//            subject's value only (helpers, module-level caches, the write
//            route a read depends on): the premise's anchors.
//   sibling  symbols whose code depends on the sibling's value only. Dropped.
//   mixed    symbols whose code depends on both (one struct holding the
//            subject's field and the sibling's). Kept, minus the lines that
//            change with the sibling's value.
//   neutral  other symbols (code that depends on neither). Dropped: not the
//            anchor's code.
// Unsymbolled lines (imports, package clauses, blank separators) are kept
// unless they change with the sibling's value, and a section is dropped if it
// keeps no subject or mixed line. The unfiltered S17b diff is rebuilt too, and
// the build checks it is byte-identical to the one S17b sent.
import { unifiedDiff } from "./diff.ts";
import type { Family, RenderArgs } from "./types.ts";

export type SymClass = "subject" | "sibling" | "mixed" | "neutral";

interface Line { text: string; sym: string | null }

function renderLines(f: Family, a: RenderArgs): Map<string, Line[]> {
  const out = new Map<string, Line[]>();
  for (const file of f.render(a)) {
    const lines: Line[] = [];
    file.blocks.forEach((blk, k) => {
      if (k > 0) lines.push({ text: "", sym: null });
      for (const text of blk.code.split("\n")) lines.push({ text, sym: blk.sym?.[0] ?? null });
    });
    out.set(file.path, lines);
  }
  return out;
}

function symCodes(f: Family, a: RenderArgs): Map<string, string> {
  const m = new Map<string, string>();
  for (const file of f.render(a)) for (const blk of file.blocks) if (blk.sym) m.set(blk.sym[0], blk.code);
  return m;
}

const sibSet = (f: Family) => [...new Set([f.baseline, ...f.sibValues])];
const subjectArgs = (f: Family): { s: string; trap?: string }[] => [
  ...f.values.map((s) => ({ s })),
  ...(f.traps ?? []).flatMap((t) => [t.before, t.after]).map((a) => ({ s: a.s, trap: a.trap })),
];

/** Classifies every symbol the family can render, over the full subject x sibling grid. */
export function symClasses(f: Family): Map<string, SymClass> {
  const grid = subjectArgs(f).map((sa) => sibSet(f).map((sib) => symCodes(f, { ...sa, sib })));
  const names = new Set(grid.flat().flatMap((m) => [...m.keys()]));
  const out = new Map<string, SymClass>();
  for (const name of names) {
    const code = (i: number, j: number) => grid[i][j].get(name) ?? "\u0000absent";
    let s = false;
    let b = false;
    for (let j = 0; j < grid[0].length; j++) if (new Set(grid.map((_, i) => code(i, j))).size > 1) s = true;
    for (let i = 0; i < grid.length; i++) if (new Set(grid[i].map((_, j) => code(i, j))).size > 1) b = true;
    const cls: SymClass = s && b ? "mixed" : s ? "subject" : b ? "sibling" : "neutral";
    out.set(name, name === f.anchor ? (b ? "mixed" : "subject") : cls);
  }
  return out;
}

/** Indices of `a` that an LCS with `b` leaves unmatched. */
function unmatched(a: string[], b: string[]): Set<number> {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n) {
    if (j < m && a[i] === b[j]) { i++; j++; }
    else if (j < m && lcs[i][j + 1] > lcs[i + 1][j]) j++;
    else out.add(i++);
  }
  return out;
}

type Keep = "subject" | "neutral" | "drop";

/** Per file, the keep class of every line of the render at `a`. */
function lineKeep(f: Family, a: RenderArgs, classes: Map<string, SymClass>): Map<string, Keep[]> {
  const base = renderLines(f, a);
  const variants = sibSet(f).filter((x) => x !== a.sib).map((sib) => renderLines(f, { ...a, sib }));
  const out = new Map<string, Keep[]>();
  for (const [path, lines] of base) {
    const sibSensitive = new Set<number>();
    for (const v of variants) for (const k of unmatched(lines.map((l) => l.text), (v.get(path) ?? []).map((l) => l.text))) sibSensitive.add(k);
    out.set(path, lines.map((l, k): Keep => {
      const cls = l.sym === null ? null : classes.get(l.sym)!;
      if (cls === "sibling" || cls === "neutral") return "drop";
      if (sibSensitive.has(k)) return "drop";
      return cls === null ? "neutral" : "subject";
    }));
  }
  return out;
}

type Op = { tag: " " | "-" | "+"; text: string; ai: number; bi: number };

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ tag: " ", text: a[i], ai: i++, bi: j++ });
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ tag: "-", text: a[i], ai: i++, bi: j });
    else out.push({ tag: "+", text: b[j], ai: i, bi: j++ });
  }
  return out;
}

export interface AnchorView {
  diff: string; // unified diff text of the anchors' code, full context
  full: string; // the unfiltered diff, rebuilt here; must equal S17b's diff
  subjectSyms: Set<string>; // symbols kept in the symbol list
  droppedLines: number;
  anchorTouched: boolean; // a kept line is a change
}

/** `context` is S17b's context setting, used only to rebuild S17b's diff for the identity check. */
export function anchorView(f: Family, before: RenderArgs, after: RenderArgs, context: number): AnchorView {
  const classes = symClasses(f);
  const ka = lineKeep(f, before, classes);
  const kz = lineKeep(f, after, classes);
  const a = renderLines(f, before);
  const z = renderLines(f, after);
  const paths = [...new Set([...a.keys(), ...z.keys()])];
  const full: string[] = [];
  const kept: string[] = [];
  let droppedLines = 0;
  let anchorTouched = false;
  for (const p of paths) {
    const x = a.get(p)?.map((l) => l.text) ?? null;
    const y = z.get(p)?.map((l) => l.text) ?? null;
    const xt = x === null ? null : x.join("\n") + "\n";
    const yt = y === null ? null : y.join("\n") + "\n";
    if (xt !== yt) full.push(unifiedDiff(p, xt, yt, context));
    const o = ops(x ?? [], y ?? []);
    const sections: string[][] = [];
    let cur: { lines: Op[]; subject: boolean } | null = null;
    const close = () => {
      if (cur && cur.subject) {
        const ls = [...cur.lines];
        while (ls.length && ls[0].tag === " " && ls[0].text.trim() === "") ls.shift();
        while (ls.length && ls.at(-1)!.tag === " " && ls.at(-1)!.text.trim() === "") ls.pop();
        sections.push([`@@ -${x === null ? 0 : ls[0].ai + 1} +${y === null ? 0 : ls[0].bi + 1} @@`, ...ls.map((l) => l.tag + l.text)]);
      }
      cur = null;
    };
    for (const op of o) {
      const keepA = op.tag === "+" ? null : ka.get(p)![op.ai];
      const keepZ = op.tag === "-" ? null : kz.get(p)![op.bi];
      const keeps = [keepA, keepZ].filter((v): v is Keep => v !== null);
      const keep: Keep = keeps.includes("drop") ? "drop" : keeps.includes("subject") ? "subject" : "neutral";
      if (keep === "drop") { if (op.tag !== " " || xt !== yt) droppedLines++; close(); continue; }
      cur ??= { lines: [], subject: false };
      cur.lines.push(op);
      if (keep === "subject") {
        cur.subject = true;
        if (op.tag !== " ") anchorTouched = true;
      }
    }
    close();
    if (sections.length) kept.push([x === null ? "--- /dev/null" : `--- a/${p}`, y === null ? "+++ /dev/null" : `+++ b/${p}`, ...sections.flat()].join("\n") + "\n");
  }
  const subjectSyms = new Set([...classes].filter(([, c]) => c === "subject" || c === "mixed").map(([n]) => n));
  return { diff: kept.join(""), full: full.join(""), subjectSyms, droppedLines, anchorTouched };
}
