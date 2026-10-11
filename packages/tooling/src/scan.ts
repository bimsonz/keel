import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Directories no rule ever reads. */
const ALWAYS_SKIPPED = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  ".terraform",
  "dist",
  "coverage",
  "tsp-output",
]);

export interface WalkOptions {
  /** Repo-relative directory prefixes to skip, e.g. "test/controls". */
  readonly skip?: readonly string[];
  /** Keep only files this returns true for (given the repo-relative path). */
  readonly keep: (path: string) => boolean;
}

/**
 * Lists files under `root` as repo-relative, forward-slashed paths, sorted.
 * Skips dependency, build and VCS directories, and any `skip` prefix.
 */
export function walk(root: string, options: WalkOptions): string[] {
  const skip = options.skip ?? [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (ALWAYS_SKIPPED.has(name)) continue;
      const abs = join(dir, name);
      const rel = toPosix(relative(root, abs));
      if (skip.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      const stat = statSync(abs);
      if (stat.isDirectory()) visit(abs);
      else if (stat.isFile() && options.keep(rel)) out.push(rel);
    }
  };
  visit(root);
  return out.toSorted();
}

/**
 * The files git would publish from `root`, relative to it: every tracked file,
 * and every untracked one no ignore rule covers (what `git add -A` stages).
 * Null when `root` is in no work tree, as in a `git archive` export, where
 * every file present is published. Any other git failure throws, so a guard
 * never reads less than it should because git broke.
 */
export function publishable(root: string): ReadonlySet<string> | null {
  const listed = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (listed.error !== undefined) throw listed.error;
  if (listed.status !== 0) {
    if (listed.status === 128 && /not a git repository/.test(listed.stderr)) return null;
    throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  }
  return new Set(listed.stdout.split("\0").filter((path) => path !== ""));
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** The workspace root: the nearest ancestor holding pnpm-workspace.yaml. */
export function repoRoot(from: string = process.cwd()): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`);
    dir = parent;
  }
}

/** 1-based line numbers of every line matching `pattern`. */
export function matchingLines(text: string, pattern: RegExp): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  text.split("\n").forEach((content, index) => {
    if (pattern.test(content)) hits.push({ line: index + 1, text: content.trim() });
  });
  return hits;
}
