// Fix 1: strip comments from the state before Clef sees it.
//
// A hunk's diff is split into its @@ sections. Each section is rebuilt as two
// streams, before (context and "-" lines) and after (context and "+" lines),
// and each stream is tokenised in full, so block comments, docstrings and
// multi-line strings are tracked across lines. Comments are removed; a line
// that held only a comment is dropped; trailing whitespace is trimmed.
//
// A section in which nothing was stripped is emitted byte-for-byte as it was.
// A section that changed is re-diffed from its two stripped streams (LCS, full
// context), so a "-"/"+" pair that differed only in a comment becomes one
// context line rather than a spurious change.
//
// Languages: typescript/javascript, go, c (// and /* */), python (# and
// statement-position docstrings), hcl (#, // and /* */), sql (-- and /* */).
// String literals are code and are kept, including their contents.

export type Lang = "typescript" | "javascript" | "go" | "c" | "python" | "hcl" | "sql" | "text";

interface Syntax {
  line: string[]; // line-comment openers
  block: boolean; // /* ... */
  quotes: string[]; // single-line string delimiters
  multiQuotes: string[]; // delimiters whose strings may span lines
  docstrings: boolean; // python: a triple-quoted string in statement position is a comment
}

const SYNTAX: Record<Lang, Syntax> = {
  typescript: { line: ["//"], block: true, quotes: ['"', "'"], multiQuotes: ["`"], docstrings: false },
  javascript: { line: ["//"], block: true, quotes: ['"', "'"], multiQuotes: ["`"], docstrings: false },
  go: { line: ["//"], block: true, quotes: ['"', "'"], multiQuotes: ["`"], docstrings: false },
  c: { line: ["//"], block: true, quotes: ['"', "'"], multiQuotes: [], docstrings: false },
  python: { line: ["#"], block: false, quotes: ['"', "'"], multiQuotes: ['"""', "'''"], docstrings: true },
  hcl: { line: ["#", "//"], block: true, quotes: ['"'], multiQuotes: [], docstrings: false },
  sql: { line: ["--"], block: true, quotes: ["'", '"'], multiQuotes: [], docstrings: false },
  text: { line: [], block: false, quotes: [], multiQuotes: [], docstrings: false },
};

/**
 * Strips comments from a sequence of source lines (one stream: a file or a
 * section of one). Returns the stripped text of each line, trailing
 * whitespace trimmed; a line that held only a comment comes back as null.
 */
export function stripLines(lines: string[], lang: Lang): (string | null)[] {
  const syn = SYNTAX[lang];
  const out: (string | null)[] = [];
  let inBlock = false; // inside /* */
  let inDoc: string | null = null; // inside a docstring, by delimiter
  let inMulti: string | null = null; // inside a multi-line string literal, by delimiter
  for (const line of lines) {
    let kept = "";
    let hadComment = inBlock || inDoc !== null;
    let quote: string | null = null;
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      if (inBlock) {
        const end = rest.indexOf("*/");
        if (end < 0) { i = line.length; break; }
        inBlock = false;
        i += end + 2;
        continue;
      }
      if (inDoc) {
        const end = rest.indexOf(inDoc);
        if (end < 0) { i = line.length; break; }
        inDoc = null;
        i += end + 3;
        continue;
      }
      if (inMulti) {
        const end = findClose(rest, inMulti);
        if (end < 0) { kept += rest; i = line.length; break; }
        kept += rest.slice(0, end + inMulti.length);
        i += end + inMulti.length;
        inMulti = null;
        continue;
      }
      if (quote) {
        const ch = line[i];
        kept += ch;
        if (ch === "\\" && i + 1 < line.length) { kept += line[i + 1]; i += 2; continue; }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      const multi = syn.multiQuotes.find((q) => rest.startsWith(q));
      if (multi) {
        if (syn.docstrings && kept.trim() === "" && /^[\t ]*$/.test(line.slice(0, i))) {
          hadComment = true;
          inDoc = multi;
          i += multi.length;
          const end = line.slice(i).indexOf(multi);
          if (end >= 0) { inDoc = null; i += end + multi.length; }
          continue;
        }
        const end = findClose(line.slice(i + multi.length), multi);
        if (end >= 0) {
          kept += line.slice(i, i + multi.length + end + multi.length);
          i += multi.length + end + multi.length;
        } else {
          kept += rest;
          inMulti = multi;
          i = line.length;
        }
        continue;
      }
      if (syn.block && rest.startsWith("/*")) { hadComment = true; inBlock = true; i += 2; continue; }
      if (syn.line.some((m) => rest.startsWith(m))) { hadComment = true; break; }
      const ch = line[i];
      if (syn.quotes.includes(ch)) quote = ch;
      kept += ch;
      i++;
    }
    const trimmed = kept.replace(/\s+$/, "");
    out.push(hadComment && trimmed.trim() === "" && line.trim() !== "" ? null : trimmed);
  }
  return out;
}

function findClose(s: string, delim: string): number {
  for (let i = 0; i <= s.length - delim.length; i++) {
    if (delim.length === 1 && s[i] === "\\") { i++; continue; }
    if (s.startsWith(delim, i)) return i;
  }
  return -1;
}

interface Section {
  oldStart: number;
  newStart: number;
  header: string;
  body: string[]; // lines with their " ", "-", "+" prefix
}

function parseSections(diff: string): { head: string[]; sections: Section[] } {
  const lines = diff.replace(/\n$/, "").split("\n");
  const head: string[] = [];
  const sections: Section[] = [];
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { sections.push({ oldStart: Number(m[1]), newStart: Number(m[2]), header: m[3], body: [] }); continue; }
    if (sections.length === 0) { head.push(line); continue; }
    sections.at(-1)!.body.push(line);
  }
  return { head, sections };
}

type Op = { tag: " " | "-" | "+"; text: string };

/** LCS line diff of two streams, every line emitted (full context). */
export function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ tag: " ", text: a[i] }); i++; j++; }
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ tag: "-", text: a[i++] });
    else ops.push({ tag: "+", text: b[j++] });
  }
  return ops;
}

export interface StripResult {
  diff: string;
  removedLines: number; // comment-only lines dropped (counted per stream)
  changedLines: number; // lines that kept code but lost a trailing comment
}

/** Strips comments from one file's unified diff (the `diff` of a state hunk). */
export function stripDiff(diff: string, language: string): StripResult {
  const lang = (language in SYNTAX ? language : "text") as Lang;
  const { head, sections } = parseSections(diff);
  const out = [...head];
  let removedLines = 0;
  let changedLines = 0;
  for (const s of sections) {
    const before = s.body.filter((l) => l[0] !== "+").map((l) => l.slice(1));
    const after = s.body.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    const sb = stripLines(before, lang);
    const sa = stripLines(after, lang);
    const header = s.header === "" ? "" : (stripLines([s.header], lang)[0] ?? "");
    const untouched = header === s.header && before.every((x, k) => sb[k] === x) && after.every((x, k) => sa[k] === x);
    if (untouched) {
      out.push(`@@ -${s.oldStart} +${s.newStart} @@${s.header}`, ...s.body);
      continue;
    }
    for (const [orig, st] of [[before, sb], [after, sa]] as const) {
      st.forEach((x, k) => {
        if (x === null) removedLines++;
        else if (x.trimEnd() !== orig[k].trimEnd()) changedLines++;
      });
    }
    const ops = lineOps(sb.filter((x): x is string => x !== null), sa.filter((x): x is string => x !== null));
    if (ops.length === 0) continue; // the section was nothing but comments
    out.push(`@@ -${s.oldStart} +${s.newStart} @@${header}`, ...ops.map((o) => o.tag + o.text));
  }
  return { diff: withCounts(out), removedLines, changedLines };
}

/** Re-emits @@ headers with line counts recomputed from the section bodies. */
export function withCounts(lines: string[]): string {
  const out: string[] = [];
  let header = -1;
  let oldCount = 0;
  let newCount = 0;
  const flush = () => {
    if (header < 0) return;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(out[header])!;
    out[header] = `@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@${m[3]}`;
  };
  for (const line of lines) {
    if (line.startsWith("@@ ")) { flush(); header = out.length; oldCount = 0; newCount = 0; out.push(line); continue; }
    out.push(line);
    if (header < 0) continue;
    if (line[0] !== "+") oldCount++;
    if (line[0] !== "-") newCount++;
  }
  flush();
  return out.join("\n") + "\n";
}

/** Number of @@ sections in a diff. */
export function sectionCount(diff: string): number {
  return (diff.match(/^@@ /gm) ?? []).length;
}
