// fast-check generators for line-level diffs and merges: files drawn from a
// few distinct lines (so runs repeat, groups slide and anchors are ambiguous),
// some with CRLF lines and some without a final newline.

import { enc } from "../src/bytes.ts";
import { fc } from "./support/fast-check.ts";

/** A file as line numbers, and how it is written out. */
export interface TextFile {
  readonly lines: readonly number[];
  /** Lines whose number is a multiple of this end in CRLF (0: none do). */
  readonly crlfEvery: number;
  readonly finalNewline: boolean;
}

export function render(f: TextFile): Uint8Array {
  const text = f.lines
    .map((n, i) => {
      const eol = f.crlfEvery > 0 && n % f.crlfEvery === 0 ? "\r\n" : "\n";
      return `l${n}${i === f.lines.length - 1 && !f.finalNewline ? "" : eol}`;
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
export const pairArb = fc
  .constantFrom(...VOCABULARIES)
  .chain((vocab) =>
    fc.record({
      base: fc.array(fc.nat({ max: vocab - 1 }), { maxLength: 40 }),
      edits: editsOf(vocab, 60),
      a: shape,
      b: shape,
    }),
  )
  .map(({ base, edits, a, b }) => ({
    a: render({ lines: base, ...a }),
    b: render({ lines: applyEdits(base, edits), ...b }),
  }));

/**
 * A base and two edited copies. Half the time ours edits only the top half
 * and theirs only the bottom, so disjoint changes to one file (the case a
 * hunk-level merge exists for) are common; otherwise edits land anywhere.
 */
export const threeWayArb = fc
  .constantFrom(...VOCABULARIES)
  .chain((vocab) =>
    fc.record({
      base: fc.array(fc.nat({ max: vocab - 1 }), { minLength: 2, maxLength: 40 }),
      split: fc.boolean(),
      ours: editsOf(vocab, 60),
      theirs: editsOf(vocab, 60),
      shape,
      endings: fc.constantFrom("same", "ours-differ", "theirs-differ"),
      oursShape: shape,
    }),
  )
  .map(({ base, split, ours, theirs, shape: s, endings, oursShape }) => {
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
      base: render({ lines: base, ...s }),
      ours: render({
        lines: applyEdits(base, bySplit(ours, top)),
        ...(endings === "ours-differ" ? oursShape : s),
      }),
      theirs: render({
        lines: applyEdits(base, bySplit(theirs, bottom)),
        ...(endings === "theirs-differ" ? oursShape : s),
      }),
    };
  });
