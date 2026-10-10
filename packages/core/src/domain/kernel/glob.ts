import { Schema } from "effect";

/** A repository path pattern, e.g. `src/authz/**` or `*.tf`, used by footprints, protected paths and step selection. */
export const Glob = Schema.NonEmptyString.pipe(Schema.brand("Glob"));
export type Glob = typeof Glob.Type;

// Matching. `**` matches zero or more whole segments, `*` any run of
// characters within a segment, `?` exactly one character.

const isWild = (segment: string): boolean => segment.includes("*") || segment.includes("?");

const split = (path: string): readonly string[] => path.split("/").filter((s) => s.length > 0);

const matchSegment = (pattern: string, text: string): boolean => {
  // reach[j]: the pattern prefix consumed so far matches text[0..j)
  let reach = Array.from<boolean>({ length: text.length + 1 }).fill(false);
  reach[0] = true;
  for (const p of pattern) {
    const next = Array.from<boolean>({ length: text.length + 1 }).fill(false);
    for (let j = 0; j <= text.length; j++) {
      if (!reach[j]) continue;
      if (p === "*") {
        for (let k = j; k <= text.length; k++) next[k] = true;
      } else if (j < text.length && (p === "?" || p === text[j])) {
        next[j + 1] = true;
      }
    }
    reach = next;
  }
  return reach[text.length] === true;
};

const matchSegments = (pattern: readonly string[], path: readonly string[]): boolean => {
  let reach = Array.from<boolean>({ length: path.length + 1 }).fill(false);
  reach[0] = true;
  for (const p of pattern) {
    const next = Array.from<boolean>({ length: path.length + 1 }).fill(false);
    for (let j = 0; j <= path.length; j++) {
      if (!reach[j]) continue;
      if (p === "**") {
        for (let k = j; k <= path.length; k++) next[k] = true;
      } else if (j < path.length && matchSegment(p, path[j] ?? "")) {
        next[j + 1] = true;
      }
    }
    reach = next;
  }
  return reach[path.length] === true;
};

export const matchesGlob = (pattern: string, path: string): boolean =>
  matchSegments(split(pattern), split(path));

export const matchesAny = (patterns: readonly string[], path: string): boolean =>
  patterns.some((p) => matchesGlob(p, path));

/** The segments before the first wildcard segment. */
export const literalPrefix = (pattern: string): readonly string[] => {
  const segments = split(pattern);
  const firstWild = segments.findIndex(isWild);
  return firstWild === -1 ? segments : segments.slice(0, firstWild);
};

const isPrefix = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((s, i) => s === b[i]);

/**
 * Could some path match both globs? Exact when either side is a literal path;
 * otherwise an over-approximation by literal prefix, which is sound: any path
 * matching both starts with both prefixes, so one prefix contains the other.
 */
export const globsMayOverlap = (a: string, b: string): boolean => {
  if (!split(a).some(isWild)) return matchesGlob(b, a);
  if (!split(b).some(isWild)) return matchesGlob(a, b);
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return isPrefix(pa, pb) || isPrefix(pb, pa);
};
