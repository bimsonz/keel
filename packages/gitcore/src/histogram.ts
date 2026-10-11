// Line diffs as git's content merge computes them. merge-ort diffs each side
// against the base with the histogram algorithm, then slides every group of
// changed lines as xdiff does (down as far as it goes, then back up to meet a
// change in the other file; no indent heuristic), and a three-way merge reads
// those scripts. Written from the algorithm and proven against git as a black
// box (`git diff --histogram --no-indent-heuristic`): no xdiff code is used.
//
// Where git would leave the histogram for its Myers fallback (a region whose
// common lines all occur more than 64 times), this refuses instead: GitCore
// does not run Myers, and a guess there could merge what git conflicts on.

/** One change: `aLen` lines of `a` from `a` replaced by `bLen` lines of `b` from `b` (0-based). */
export interface Hunk {
  readonly a: number;
  readonly aLen: number;
  readonly b: number;
  readonly bLen: number;
}

/** Lines past which git's histogram gives up on a region and falls back to Myers. */
const MAX_CHAIN = 64;

/** Why no script came back: git would fall back to Myers, or the work outgrew its budget. */
export class Unsure extends Error {
  constructor(readonly why: "diff-fallback" | "too-large") {
    super(why);
  }
}

/** Steps a diff may take before it is refused: histogram is quadratic at worst. */
export class Budget {
  #left: number;

  constructor(steps: number) {
    this.#left = steps;
  }

  spend(steps: number): void {
    this.#left -= steps;
    if (this.#left < 0) throw new Unsure("too-large");
  }
}

/** About a second of a Worker's CPU. */
export const DIFF_BUDGET = 50_000_000;

/** A file's lines: each up to and including its newline; the last may lack one. */
export function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let nl = bytes.indexOf(0x0a); nl !== -1; nl = bytes.indexOf(0x0a, start)) {
    lines.push(bytes.subarray(start, nl + 1));
    start = nl + 1;
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

/** Gives equal lines one id, so a diff compares numbers; byte for byte, as git does with no flags. */
export class LineIds {
  readonly #ids = new Map<string, number>();

  of(lines: readonly Uint8Array[]): Int32Array {
    const out = new Int32Array(lines.length);
    for (const [i, line] of lines.entries()) {
      const key = latin1(line);
      let id = this.#ids.get(key);
      if (id === undefined) {
        id = this.#ids.size;
        this.#ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  }
}

/** One char per byte: two lines are equal exactly when their keys are. */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let at = 0; at < bytes.length; at += 4096)
    s += String.fromCharCode(...bytes.subarray(at, at + 4096));
  return s;
}

/**
 * One file's lines as ids, which of them the diff changed (`changed[i + 1]`,
 * with a clear line either side), and which of them a group entered or left
 * while compaction slid it (`slid[i + 1]`).
 */
interface Side {
  readonly ids: Int32Array;
  readonly changed: Uint8Array;
  readonly slid: Uint8Array;
}

const sideOf = (ids: Int32Array): Side => ({
  ids,
  changed: new Uint8Array(ids.length + 2),
  slid: new Uint8Array(ids.length + 2),
});
const isChanged = (s: Side, i: number) => s.changed[i + 1] === 1;
const hasSlid = (s: Side, i: number) => s.slid[i + 1] === 1;
/** A slide's step: the line joins or leaves its group, and is remembered as slid over. */
const setChanged = (s: Side, i: number, v: 0 | 1) => {
  s.changed[i + 1] = v;
  s.slid[i + 1] = 1;
};
const mark = (s: Side, from: number, to: number) => s.changed.fill(1, from + 1, to + 1);

// ---------------------------------------------------------------- histogram

interface Run {
  readonly a: number;
  readonly b: number;
  readonly len: number;
}

/**
 * The region's anchor run: lines of `b` met in `a`, the rarer (by count in
 * `a`'s region) or longer winning, scanned in `b`'s order as git does.
 * Undefined when the regions share no line.
 */
function anchor(
  a: Int32Array,
  b: Int32Array,
  aS: number,
  aE: number,
  bS: number,
  bE: number,
  budget: Budget,
): Run | undefined {
  // Each line of a's region: its count, its first position and, per position, the next.
  const count = new Map<number, number>();
  const first = new Map<number, number>();
  const next = new Int32Array(aE - aS);
  for (let p = aE - 1; p >= aS; p--) {
    const id = a[p] ?? -1;
    next[p - aS] = first.get(id) ?? -1;
    first.set(id, p);
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  budget.spend(aE - aS + bE - bS);

  let best: Run | undefined;
  /** git compares a candidate's end - begin with the best's, which starts at 0 as if a one-line run were held. */
  let span = 0;
  let bestCount = MAX_CHAIN + 1;
  let common = false;
  for (let bp = bS; bp < bE;) {
    let bNext = bp + 1;
    const id = b[bp] ?? -1;
    const c = count.get(id);
    if (c !== undefined) common = true;
    if (c !== undefined && c <= bestCount) {
      for (let as = first.get(id) ?? -1; ;) {
        let s1 = as;
        let s2 = bp;
        let e1 = as;
        let e2 = bp;
        let rc = c;
        while (s1 > aS && s2 > bS && a[s1 - 1] === b[s2 - 1]) {
          s1--;
          s2--;
          if (rc > 1) rc = Math.min(rc, count.get(a[s1] ?? -1) ?? rc);
        }
        while (e1 + 1 < aE && e2 + 1 < bE && a[e1 + 1] === b[e2 + 1]) {
          e1++;
          e2++;
          if (rc > 1) rc = Math.min(rc, count.get(a[e1] ?? -1) ?? rc);
        }
        budget.spend(e1 - s1 + 1);
        if (bNext <= e2) bNext = e2 + 1;
        if (span < e1 - s1 || rc < bestCount) {
          best = { a: s1, b: s2, len: e1 - s1 + 1 };
          span = e1 - s1;
          bestCount = rc;
        }
        let np = next[as - aS] ?? -1;
        while (np !== -1 && np <= e1) np = next[np - aS] ?? -1;
        if (np === -1) break;
        as = np;
      }
    }
    bp = bNext;
  }
  if (common && bestCount > MAX_CHAIN) throw new Unsure("diff-fallback");
  return best;
}

/** Marks what changed between `a` and `b`, region by region around each anchor run. */
function histogram(a: Side, b: Side, budget: Budget): void {
  const regions: [number, number, number, number][] = [[0, a.ids.length, 0, b.ids.length]];
  for (let region = regions.pop(); region !== undefined; region = regions.pop()) {
    const [aS, aE, bS, bE] = region;
    if (aS === aE || bS === bE) {
      mark(a, aS, aE);
      mark(b, bS, bE);
      continue;
    }
    const run = anchor(a.ids, b.ids, aS, aE, bS, bE, budget);
    if (run === undefined) {
      mark(a, aS, aE);
      mark(b, bS, bE);
      continue;
    }
    regions.push([aS, run.a, bS, run.b], [run.a + run.len, aE, run.b + run.len, bE]);
  }
}

// ---------------------------------------------------------------- compaction

/** A run of changed lines `[start, end)`; empty between two unchanged lines. Groups of the two files pair up in order. */
interface Group {
  start: number;
  end: number;
}

function firstGroup(s: Side): Group {
  let end = 0;
  while (isChanged(s, end)) end++;
  return { start: 0, end };
}

function nextGroup(s: Side, g: Group): boolean {
  if (g.end === s.ids.length) return false;
  g.start = g.end + 1;
  g.end = g.start;
  while (isChanged(s, g.end)) g.end++;
  return true;
}

function previousGroup(s: Side, g: Group): boolean {
  if (g.start === 0) return false;
  g.end = g.start - 1;
  g.start = g.end;
  while (isChanged(s, g.start - 1)) g.start--;
  return true;
}

/** Moves the group one line down when the line after it equals its first, joining any group it meets. */
function slideDown(s: Side, g: Group): boolean {
  if (g.end >= s.ids.length || s.ids[g.start] !== s.ids[g.end]) return false;
  setChanged(s, g.start, 0);
  g.start++;
  setChanged(s, g.end, 1);
  g.end++;
  while (isChanged(s, g.end)) g.end++;
  return true;
}

/** Moves the group one line up when the line before it equals its last, joining any group it meets. */
function slideUp(s: Side, g: Group): boolean {
  if (g.start <= 0 || s.ids[g.start - 1] !== s.ids[g.end - 1]) return false;
  g.start--;
  setChanged(s, g.start, 1);
  g.end--;
  setChanged(s, g.end, 0);
  while (isChanged(s, g.start - 1)) g.start--;
  return true;
}

function inSync(stepped: boolean): void {
  if (!stepped) throw new Error("diff groups out of step");
}

/** Slides each group of `x`'s changes as low as it goes, then back up to the last place it meets a change in `o`. */
function compact(x: Side, o: Side, budget: Budget): void {
  const g = firstGroup(x);
  const go = firstGroup(o);
  for (;;) {
    if (g.end !== g.start) {
      let size: number;
      let earliestEnd: number;
      let endMeetingOther: number;
      do {
        size = g.end - g.start;
        endMeetingOther = -1;
        while (slideUp(x, g)) inSync(previousGroup(o, go));
        earliestEnd = g.end;
        if (go.end > go.start) endMeetingOther = g.end;
        while (slideDown(x, g)) {
          inSync(nextGroup(o, go));
          if (go.end > go.start) endMeetingOther = g.end;
        }
        budget.spend(g.end - g.start + 1);
      } while (size !== g.end - g.start);
      if (g.end !== earliestEnd && endMeetingOther !== -1) {
        while (go.end === go.start) {
          inSync(slideUp(x, g));
          inSync(previousGroup(o, go));
        }
      }
    }
    if (!nextGroup(x, g)) break;
    inSync(nextGroup(o, go));
  }
}

// ---------------------------------------------------------------- script

function script(a: Side, b: Side): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < a.ids.length || j < b.ids.length) {
    if (!isChanged(a, i) && !isChanged(b, j)) {
      i++;
      j++;
      continue;
    }
    const from = { a: i, b: j };
    while (i < a.ids.length && isChanged(a, i)) i++;
    while (j < b.ids.length && isChanged(b, j)) j++;
    hunks.push({ a: from.a, aLen: i - from.a, b: from.b, bLen: j - from.b });
  }
  return hunks;
}

/**
 * Where a hunk may lie in a later git's script: base lines `[aFrom, aTo)` and
 * the side lines `[bFrom, bTo)` they pair with.
 *
 * Through 2.53 the script above is git's. From 2.54 (git e417277ae9, "xdiff:
 * re-diff shifted change groups when using histogram algorithm") compaction
 * does more: when a shift lines a group up with a changed group in the other
 * file, git re-diffs that pair with its fall-back Myers diff, which clears
 * the lines the two share, and compaction then slides the smaller groups left
 * behind as it slides any group. GitCore runs no Myers, so it doesn't follow
 * the re-diff: it bounds where the result can lie.
 *
 * A group slides only over lines equal to one of its own, joins any group of
 * its file it touches, and passes the other file's groups whatever they hold.
 * So a hunk compaction moved reaches, in both directions, over
 *  - every unchanged line equal to a line of a hunk it holds (the equal-lines
 *    span: wherever its groups, whole or re-diffed, could slide to);
 *  - every unchanged line a group entered or left while compaction slid it
 *    (the full slide range, up and down, not only where the group came to rest);
 *  - every hunk those lines lead to, whose lines then count as its own.
 * A hunk compaction left as histogram marked it is one of histogram's own
 * regions, whose two sides share no line, so a re-diff finds nothing in it:
 * it reaches its own span and no further.
 */
export interface Reach {
  readonly aFrom: number;
  readonly aTo: number;
  readonly bFrom: number;
  readonly bTo: number;
}

export interface ReachingHunk extends Hunk {
  readonly reach: Reach;
}

/** Whether compaction left other marks in `[from - 1, to]` than histogram made. */
function moved(now: Side, then: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i <= to + 1; i++) if (now.changed[i] !== then[i]) return true;
  return false;
}

/** Each hunk with its reach; `then` holds the marks histogram made, before compaction. */
function reaching(
  hunks: readonly Hunk[],
  a: Side,
  b: Side,
  then: { readonly a: Uint8Array; readonly b: Uint8Array },
  budget: Budget,
): ReachingHunk[] {
  return hunks.map((h, at) => {
    let [aFrom, aTo, bFrom, bTo] = [h.a, h.a + h.aLen, h.b, h.b + h.bLen];
    if (!moved(a, then.a, aFrom, aTo) && !moved(b, then.b, bFrom, bTo))
      return { ...h, reach: { aFrom, aTo, bFrom, bTo } };
    const own = new Set<number>();
    const hold = (x: Hunk) => {
      for (let i = x.a; i < x.a + x.aLen; i++) own.add(a.ids[i] ?? -1);
      for (let j = x.b; j < x.b + x.bLen; j++) own.add(b.ids[j] ?? -1);
    };
    hold(h);
    /** The unchanged pair `a[i]`, `b[j]` is one a group of this reach could slide over. */
    const within = (i: number, j: number) =>
      own.has(a.ids[i] ?? -1) || hasSlid(a, i) || hasSlid(b, j);
    let first = at;
    let last = at;
    // A hunk taken in brings lines of its own, which may carry the reach further the other way.
    for (let held = 0; held !== last - first + 1;) {
      held = last - first + 1;
      for (;;) {
        const below = hunks[last + 1];
        if (below !== undefined && below.a === aTo && below.b === bTo) {
          hold(below);
          aTo += below.aLen;
          bTo += below.bLen;
          last++;
        } else if (aTo < a.ids.length && bTo < b.ids.length && within(aTo, bTo)) {
          aTo++;
          bTo++;
        } else break;
      }
      for (;;) {
        const above = hunks[first - 1];
        if (
          above !== undefined &&
          above.a + above.aLen === aFrom &&
          above.b + above.bLen === bFrom
        ) {
          hold(above);
          aFrom -= above.aLen;
          bFrom -= above.bLen;
          first--;
        } else if (aFrom > 0 && bFrom > 0 && within(aFrom - 1, bFrom - 1)) {
          aFrom--;
          bFrom--;
        } else break;
      }
      budget.spend(aTo - aFrom + bTo - bFrom);
    }
    return { ...h, reach: { aFrom, aTo, bFrom, bTo } };
  });
}

/** git's script from `a`'s lines to `b`'s, by id, each hunk with its reach. Throws `Unsure`. */
export function diffIds(a: Int32Array, b: Int32Array, budget: Budget): ReachingHunk[] {
  const sa = sideOf(a);
  const sb = sideOf(b);
  histogram(sa, sb, budget);
  const then = { a: sa.changed.slice(), b: sb.changed.slice() };
  compact(sa, sb, budget);
  compact(sb, sa, budget);
  return reaching(script(sa, sb), sa, sb, then, budget);
}

/** git's script from `a`'s lines to `b`'s, each hunk with its reach, or why it can't be given. */
export function diffLines(
  a: Uint8Array,
  b: Uint8Array,
  budget = new Budget(DIFF_BUDGET),
): ReachingHunk[] | Unsure {
  const ids = new LineIds();
  try {
    return diffIds(ids.of(splitLines(a)), ids.of(splitLines(b)), budget);
  } catch (e) {
    if (e instanceof Unsure) return e;
    throw e;
  }
}
