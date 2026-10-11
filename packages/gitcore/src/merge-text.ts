// A three-way merge of one text file, as git's content merge (xdiff at its
// "zealous" level, no -X options) writes it when it is clean. Each side's
// script against the base comes from `histogram.ts`, each hunk with its reach:
// where a git from 2.54 on may put that change instead. Every reach of ours
// and every reach of theirs must be parted by at least one base line neither
// holds; anything closer is refused, including the same change made on both
// sides, which git would still merge. The bytes come from the hunks. Refusing
// more than git is allowed; merging what git conflicts on, or writing other
// bytes, is not.
//
// Text only: the caller refuses binaries, as git's merge does.

import { concat } from "./bytes.ts";
import {
  Budget,
  DIFF_BUDGET,
  diffIds,
  type Hunk,
  LineIds,
  type ReachingHunk,
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

/**
 * Whether a base line neither side holds lies between every reach of ours and
 * every reach of theirs (xdiff's strict `<`). A reach can run past its side's
 * next hunk, so each is held against all the other side's that start before it.
 */
function parted(ours: readonly ReachingHunk[], theirs: readonly ReachingHunk[]): boolean {
  const reaches = [
    ...ours.map((h) => ({ ...h.reach, ours: true })),
    ...theirs.map((h) => ({ ...h.reach, ours: false })),
  ].toSorted((x, y) => x.aFrom - y.aFrom);
  const end = { ours: -1, theirs: -1 };
  for (const r of reaches) {
    if ((r.ours ? end.theirs : end.ours) >= r.aFrom) return false;
    if (r.ours) end.ours = Math.max(end.ours, r.aTo);
    else end.theirs = Math.max(end.theirs, r.aTo);
  }
  return true;
}

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
  let toOurs: ReachingHunk[];
  let toTheirs: ReachingHunk[];
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
  if (!parted(toOurs, toTheirs)) return refused("overlap");
  let i = 0;
  let j = 0;
  for (let o = toOurs[0], t = toTheirs[0]; o !== undefined || t !== undefined;) {
    if (o !== undefined && (t === undefined || o.a < t.a)) {
      take(o, lines.ours);
      o = toOurs[++i];
    } else if (t !== undefined) {
      take(t, lines.theirs);
      t = toTheirs[++j];
    }
  }
  copy(lines.base, at, lines.base.length);
  return { ok: true, merged: concat(out) };
}
