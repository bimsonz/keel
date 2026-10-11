// fast-check generators for line-level diffs and merges: files drawn from a
// few distinct lines (so runs repeat, groups slide and anchors are ambiguous),
// some with CRLF lines and some without a final newline. A file's style says
// how its line numbers are written: plainly, with LF and CRLF copies of one
// line side by side, mostly blank, or as a changelog's headings, bullets and
// blank lines. Those are the texts where compaction slides groups furthest,
// and where git from 2.54 re-diffs them.

import { enc } from "../src/bytes.ts";
import { fc } from "./support/fast-check.ts";

export const STYLES = ["numbered", "mixed-eol", "blank-heavy", "changelog"] as const;
export type Style = (typeof STYLES)[number];

/** A file as line numbers, and how it is written out. */
export interface TextFile {
  readonly lines: readonly number[];
  readonly style: Style;
  /** Lines whose number is a multiple of this end in CRLF (0: none do). */
  readonly crlfEvery: number;
  readonly finalNewline: boolean;
}

/** A changelog's lines by number: two in six are blank, and headings repeat. */
function changelogLine(n: number): string {
  const round = Math.floor(n / 6);
  return ["", "", "### Added", "### Fixed", `## ${round}.0.0`, `- entry ${round}`][n % 6] ?? "";
}

/** A line number's text, and whether the style itself ends it in CRLF. */
function written(style: Style, n: number): { readonly text: string; readonly crlf: boolean } {
  switch (style) {
    case "numbered":
      return { text: `l${n}`, crlf: false };
    case "mixed-eol":
      return { text: `l${n >> 1}`, crlf: n % 2 === 1 };
    case "blank-heavy":
      return { text: n % 3 === 0 ? `l${n / 3}` : "", crlf: false };
    case "changelog":
      return { text: changelogLine(n), crlf: false };
    default: {
      const unreachable: never = style;
      return unreachable;
    }
  }
}

export function render(f: TextFile): Uint8Array {
  const text = f.lines
    .map((n, i) => {
      const line = written(f.style, n);
      const crlf = line.crlf || (f.crlfEvery > 0 && n % f.crlfEvery === 0);
      const eol = i === f.lines.length - 1 && !f.finalNewline ? "" : "\n";
      return `${line.text}${crlf && eol !== "" ? "\r" : ""}${eol}`;
    })
    .join("");
  return enc.encode(text);
}

/** One edit: delete `del` lines at `at` (taken modulo the length), then insert `ins` there. */
export interface Edit {
  readonly at: number;
  readonly del: number;
  readonly ins: readonly number[];
}

export function applyEdits(lines: readonly number[], edits: readonly Edit[]): number[] {
  const out = [...lines];
  for (const e of edits) {
    const at = e.at % (out.length + 1);
    out.splice(at, e.del, ...e.ins);
  }
  return out;
}

const VOCABULARIES = [2, 3, 5, 12, 200] as const;
const kind = fc.record({
  vocab: fc.constantFrom(...VOCABULARIES),
  style: fc.constantFrom(...STYLES),
});

const shape = fc.record({
  crlfEvery: fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, fc.constantFrom(1, 2, 3)),
  finalNewline: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, fc.constant(false)),
});

const editsOf = (vocab: number, maxAt: number) =>
  fc.array(
    fc.record({
      at: fc.nat({ max: maxAt }),
      del: fc.nat({ max: 3 }),
      ins: fc.array(fc.nat({ max: vocab - 1 }), { maxLength: 3 }),
    }),
    { minLength: 1, maxLength: 4 },
  );

/** A file and an edited copy, each written out on its own (line endings may differ). */
export const pairArb = kind
  .chain(({ vocab, style }) =>
    fc.record({
      style: fc.constant(style),
      base: fc.array(fc.nat({ max: vocab - 1 }), { maxLength: 40 }),
      edits: editsOf(vocab, 60),
      a: shape,
      b: shape,
    }),
  )
  .map(({ style, base, edits, a, b }) => ({
    a: render({ lines: base, style, ...a }),
    b: render({ lines: applyEdits(base, edits), style, ...b }),
  }));

/**
 * A base and two edited copies. Half the time ours edits only the top half
 * and theirs only the bottom, so disjoint changes to one file (the case a
 * hunk-level merge exists for) are common; otherwise edits land anywhere.
 */
export const threeWayArb = kind
  .chain(({ vocab, style }) =>
    fc.record({
      style: fc.constant(style),
      base: fc.array(fc.nat({ max: vocab - 1 }), { minLength: 2, maxLength: 40 }),
      split: fc.boolean(),
      ours: editsOf(vocab, 60),
      theirs: editsOf(vocab, 60),
      shape,
      endings: fc.constantFrom("same", "ours-differ", "theirs-differ"),
      oursShape: shape,
    }),
  )
  .map(({ style, base, split, ours, theirs, shape: s, endings, oursShape }) => {
    const half = Math.floor(base.length / 2);
    // Split edits stay on their own half of the base and are applied bottom-up, so their positions hold.
    const top = (e: Edit) => ({
      ...e,
      at: e.at % (half + 1),
      del: Math.min(e.del, half - (e.at % (half + 1))),
    });
    const bottom = (e: Edit) => ({ ...e, at: half + 1 + (e.at % (base.length - half)) });
    const bySplit = (edits: readonly Edit[], place: (e: Edit) => Edit) =>
      split ? edits.map(place).toSorted((x, y) => y.at - x.at) : edits;
    return {
      base: render({ lines: base, style, ...s }),
      ours: render({
        lines: applyEdits(base, bySplit(ours, top)),
        style,
        ...(endings === "ours-differ" ? oursShape : s),
      }),
      theirs: render({
        lines: applyEdits(base, bySplit(theirs, bottom)),
        style,
        ...(endings === "theirs-differ" ? oursShape : s),
      }),
    };
  });

const SECTIONS = ["Added", "Changed", "Fixed", "Removed"] as const;

/** Where a side appends: a section (counted across releases), its top or bottom, and how many entries. */
const appendArb = fc.record({
  section: fc.nat({ max: 11 }),
  top: fc.boolean(),
  entries: fc.integer({ min: 1, max: 2 }),
});

/**
 * A changelog and two appends to different sections of it: releases of
 * `### ` sections of bullet entries, blank lines around headings and (in some)
 * between entries, so the same headings and many blank lines repeat. The
 * common same-file change a hunk merge exists for.
 */
export const changelogArb = fc
  .record({
    // Per release, each section's number of entries.
    releases: fc.array(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 2, maxLength: 4 }), {
      minLength: 1,
      maxLength: 3,
    }),
    blankAfterHeading: fc.boolean(),
    blankBetweenEntries: fc.boolean(),
    ours: appendArb,
    theirs: appendArb,
  })
  .map(({ releases, blankAfterHeading, blankBetweenEntries, ours, theirs }) => {
    const sections = releases.reduce((n, r) => n + r.length, 0);
    const oursAt = ours.section % sections;
    const theirsAt = (oursAt + 1 + (theirs.section % (sections - 1))) % sections;
    const write = (adds: readonly { at: number; who: string; top: boolean; entries: number }[]) => {
      const lines = ["# Changelog", ""];
      let section = 0;
      for (const [r, counts] of releases.entries()) {
        lines.push(r === 0 ? "## Unreleased" : `## ${releases.length - r}.0.0`, "");
        for (const [s, count] of counts.entries()) {
          const entries = Array.from({ length: count }, (_, i) => `- ${r}.${s} entry ${i}`);
          for (const add of adds.filter((x) => x.at === section)) {
            const added = Array.from({ length: add.entries }, (_, i) => `- ${add.who} entry ${i}`);
            if (add.top) entries.unshift(...added);
            else entries.push(...added);
          }
          lines.push(`### ${SECTIONS[s]}`, ...(blankAfterHeading ? [""] : []));
          lines.push(
            ...entries.flatMap((e, i) => (blankBetweenEntries && i > 0 ? ["", e] : [e])),
            "",
          );
          section += 1;
        }
      }
      return enc.encode(lines.map((l) => `${l}\n`).join(""));
    };
    const mine = { at: oursAt, who: "ours", top: ours.top, entries: ours.entries };
    const yours = { at: theirsAt, who: "theirs", top: theirs.top, entries: theirs.entries };
    return {
      base: write([]),
      ours: write([mine]),
      theirs: write([yours]),
      both: write([mine, yours]),
    };
  });
