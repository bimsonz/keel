// A three-way merge of one text file, as git's content merge (xdiff at its
// "zealous" level, no -X options) writes it when it is clean. Each side's
// script against the base comes from `histogram.ts`. A hunk of ours and a hunk
// of theirs must be parted by at least one base line neither changes;
// anything closer is refused, including the same change made on both sides,
// which git would still merge. Refusing more than git is allowed; merging what
// git conflicts on, or writing other bytes, is not.
//
// Text only: the caller refuses binaries, as git's merge does.

import { concat } from "./bytes.ts";
import {
  Budget,
  DIFF_BUDGET,
  diffIds,
  type Hunk,
  LineIds,
  splitLines,
  Unsure,
} from "./histogram.ts";

export type TextRefusal = "overlap" | "diff-fallback" | "too-large";

export type TextMerge =
  | { readonly ok: true; readonly merged: Uint8Array }
  | { readonly ok: false; readonly reason: TextRefusal };

/** The largest version of a file GitCore merges by hunk; larger ones go to MergeBox. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const refused = (reason: TextRefusal): TextMerge => ({ ok: false, reason });

/** Merges ours and theirs, both changed from base, or says why not. */
export function mergeText(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
  budget = new Budget(DIFF_BUDGET),
): TextMerge {
  if (Math.max(base.length, ours.length, theirs.length) > MAX_TEXT_BYTES)
    return refused("too-large");
  const ids = new LineIds();
  const lines = { base: splitLines(base), ours: splitLines(ours), theirs: splitLines(theirs) };
  const baseIds = ids.of(lines.base);
  let toOurs: Hunk[];
  let toTheirs: Hunk[];
  try {
    toOurs = diffIds(baseIds, ids.of(lines.ours), budget);
    toTheirs = diffIds(baseIds, ids.of(lines.theirs), budget);
  } catch (e) {
    if (e instanceof Unsure) return refused(e.why);
    throw e;
  }
  if (toOurs.length === 0) return { ok: true, merged: theirs };
  if (toTheirs.length === 0) return { ok: true, merged: ours };

  const out: Uint8Array[] = [];
  const copy = (from: readonly Uint8Array[], start: number, end: number) => {
    for (let k = start; k < end; k++) out.push(from[k] ?? new Uint8Array(0));
  };
  let at = 0;
  const take = (h: Hunk, side: readonly Uint8Array[]) => {
    copy(lines.base, at, h.a);
    copy(side, h.b, h.b + h.bLen);
    at = h.a + h.aLen;
  };
  let i = 0;
  let j = 0;
  for (let o = toOurs[0], t = toTheirs[0]; o !== undefined || t !== undefined;) {
    if (o !== undefined && (t === undefined || o.a + o.aLen < t.a)) {
      take(o, lines.ours);
      o = toOurs[++i];
    } else if (t !== undefined && (o === undefined || t.a + t.aLen < o.a)) {
      take(t, lines.theirs);
      t = toTheirs[++j];
    } else {
      return refused("overlap");
    }
  }
  copy(lines.base, at, lines.base.length);
  return { ok: true, merged: concat(out) };
}
