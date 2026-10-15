/**
 * The path rule: a reading parses the seeds it is given and follows their
 * relative imports to a fixpoint, breadth-first, inside fixed caps. The
 * caller reads the blobs and answers what a path is; everything else is
 * decided here, so the rule is the same wherever the blobs come from. A
 * reading asks what a path is only for a seed or a path it named beforehand,
 * so a caller can learn that from the few directories it needs.
 */
import type { Node } from "web-tree-sitter";
import { type FileModel, modelOf, nestsBeyond } from "./model.ts";
import type { SourceParser } from "./parser.ts";
import { factsOf, type TreeFacts } from "./resolve.ts";

export const LIMITS = {
  /** Files read in one call, seeds included. A file past it is `beyond-cap`; more seeds than this is no reading at all. */
  files: 400,
  /** One file's bytes. */
  fileBytes: 512 * 1024,
  /** Every parsed file's bytes together. */
  totalBytes: 8 * 1024 * 1024,
  /** Files the parser may give up on (`too-slow`, `unparseable`) before the call is given up. */
  failures: 4,
  /** How deep a file's tree may nest. Source as people write it stays under a hundred levels. */
  depth: 500,
};

/** The file types read. `.tsx` needs a second grammar and is not one of them. */
const SUPPORTED = [".ts", ".mts", ".cts", ".js"];
const TS_FOR_JS: Readonly<Record<string, string>> = {
  ".js": ".ts",
  ".mjs": ".mts",
  ".cjs": ".cts",
};

/** The method names that register an event handler, when the caller gives none. */
export const DEFAULT_REGISTRARS: readonly string[] = [
  "subscribe",
  "on",
  "addListener",
  "addEventListener",
];

export type SkipReason =
  | "absent"
  | "syntax-error"
  | "unsupported"
  | "too-large"
  | "beyond-cap"
  | "too-slow"
  | "unparseable";
export type Skipped = { readonly path: string; readonly reason: SkipReason };
export type UnavailableReason = "too-many-seeds" | "too-many-bytes" | "too-many-failures";
export type ReadingResult =
  | {
      readonly facts: TreeFacts;
      readonly skipped: readonly Skipped[];
      /** Every file parsed, in path order: the seeds at the commit and the files their imports reached. */
      readonly read: readonly string[];
    }
  | { readonly unavailable: UnavailableReason };

/** What a path is at the commit: a regular file, something else (a symlink, a submodule), or nothing. */
export type PathKind = "file" | "other" | undefined;

export interface Reading {
  /**
   * The paths to read now, one breadth-first level in path order. Empty when
   * the reading is done. Once a level's files are all given, the next call
   * resolves their imports first.
   */
  readonly wanted: () => readonly string[];
  /**
   * Gives one wanted file's bytes. `restart` means the parser's runtime is
   * gone: boot again and give the same file to the new parser.
   */
  readonly give: (path: string, bytes: Uint8Array, parser: SourceParser) => "taken" | "restart";
  /**
   * The paths whose kinds the next `wanted()`, and `result()`, will ask
   * about the files given since the last level's imports were resolved:
   * every file each module they name may be, in path order. Nothing else is
   * asked but the seeds, so a caller that learns kinds a directory at a time
   * lists these paths' directories before it asks for the next level.
   */
  readonly lookups: () => readonly string[];
  readonly result: () => ReadingResult;
}

const extensionOf = (path: string): string => /\.[A-Za-z0-9]+$/.exec(path)?.[0] ?? "";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The files a relative specifier may name from `from`, most exact first. */
const candidates = (from: string, specifier: string): readonly string[] => {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return [];
  }
  const base = parts.join("/");
  const extension = extensionOf(base);
  const swapped = TS_FOR_JS[extension];
  return [
    ...(extension === "" ? [] : [base]),
    ...(swapped === undefined ? [] : [`${base.slice(0, -extension.length)}${swapped}`]),
    ...SUPPORTED.map((ending) => `${base}${ending}`),
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
};

/**
 * The modules a file names that its reading resolves: its relative imports,
 * which are followed, and the source of each of its re-exports, bare or not,
 * which `factsOf` resolves the same way when a name is looked up through it.
 */
const named = (model: FileModel): ReadonlySet<string> =>
  new Set([...model.specifiers, ...model.reexports.map((r) => r.from), ...model.stars]);

export function openReading(
  seeds: readonly string[],
  kindOf: (path: string) => PathKind,
  registrars: readonly string[] = DEFAULT_REGISTRARS,
): Reading {
  const vocabulary = new Set(registrars);
  const models = new Map<string, FileModel>();
  const skipped = new Map<string, SkipReason>();
  const seen = new Set<string>();
  let level: string[] = [];
  let pending = new Set<string>();
  /** The files read since the last level's imports were resolved, with what each says. */
  let given: (readonly [string, FileModel])[] = [];
  let files = 0;
  let bytes = 0;
  let failures = 0;
  let unavailable: UnavailableReason | undefined;

  const resolve = (from: string, specifier: string): string | undefined =>
    candidates(from, specifier).find((candidate) => kindOf(candidate) !== undefined);

  /** Queues the paths for reading, in path order, or says why each is not read. */
  const queue = (paths: Iterable<string>): void => {
    level = [];
    for (const path of [...new Set(paths)].toSorted(byPath)) {
      if (seen.has(path)) continue;
      seen.add(path);
      const kind = /^(\/|\.\.?(\/|$))|\/\.\.?(\/|$)|^$/.test(path) ? undefined : kindOf(path);
      if (kind === undefined) skipped.set(path, "absent");
      else if (kind !== "file" || !SUPPORTED.includes(extensionOf(path)))
        skipped.set(path, "unsupported");
      else if (files >= LIMITS.files) skipped.set(path, "beyond-cap");
      else {
        files += 1;
        level.push(path);
      }
    }
    pending = new Set(level);
  };

  /** Resolves the read level's imports, in path order, and queues the files they name that were not seen. */
  const advance = (): void => {
    const next = new Set<string>();
    for (const [path, model] of given.toSorted(([a], [b]) => byPath(a, b)))
      for (const specifier of model.specifiers) {
        const target = resolve(path, specifier);
        if (target !== undefined && !seen.has(target)) next.add(target);
      }
    given = [];
    queue(next);
  };

  if (new Set(seeds).size > LIMITS.files) unavailable = "too-many-seeds";
  else queue(seeds);

  const read = (root: Node): FileModel | "syntax-error" | "unparseable" => {
    if (root.hasError) return "syntax-error";
    return nestsBeyond(root, LIMITS.depth) ? "unparseable" : modelOf(root, vocabulary);
  };

  return {
    wanted: () => {
      if (unavailable !== undefined) return [];
      if (pending.size === 0 && level.length > 0) advance();
      return level;
    },
    give: (path, blob, parser) => {
      if (unavailable !== undefined || !pending.has(path)) return "taken";
      const done = (reason?: SkipReason): "taken" => {
        if (reason !== undefined) skipped.set(path, reason);
        pending.delete(path);
        return "taken";
      };
      if (blob.length > LIMITS.fileBytes) return done("too-large");
      let text: string;
      try {
        text = utf8.decode(blob);
      } catch {
        return done("unsupported");
      }
      if (bytes + blob.length > LIMITS.totalBytes) {
        unavailable = "too-many-bytes";
        return "taken";
      }
      const model = parser.read(text, read);
      if (model === "restart") return "restart";
      bytes += blob.length;
      if (model === "too-slow" || model === "unparseable") {
        failures += 1;
        if (failures >= LIMITS.failures) unavailable = "too-many-failures";
        return done(model);
      }
      if (model === "syntax-error") return done(model);
      models.set(path, model);
      given.push([path, model]);
      return done();
    },
    lookups: () =>
      unavailable === undefined
        ? [
            ...new Set(
              given.flatMap(([path, model]) =>
                [...named(model)].flatMap((specifier) => candidates(path, specifier)),
              ),
            ),
          ].toSorted(byPath)
        : [],
    result: () =>
      unavailable === undefined
        ? {
            facts: factsOf(models, (from, specifier) => {
              const target = resolve(from, specifier);
              return target !== undefined && models.has(target) ? target : undefined;
            }),
            skipped: [...skipped]
              .map(([path, reason]) => ({ path, reason }))
              .toSorted((a, b) => byPath(a.path, b.path)),
            read: [...models.keys()].toSorted(byPath),
          }
        : { unavailable },
  };
}

/**
 * Reads a whole tree held in memory: the same rule, with the blobs to hand.
 * `boot` gives the parser, and is asked again when a file has killed its runtime.
 */
export async function readTree(
  boot: () => Promise<SourceParser>,
  tree: Readonly<Record<string, string | Uint8Array>>,
  seeds: readonly string[],
  registrars: readonly string[] = DEFAULT_REGISTRARS,
): Promise<ReadingResult> {
  const encoder = new TextEncoder();
  const reading = openReading(seeds, (path) => (path in tree ? "file" : undefined), registrars);
  let parser = await boot();
  for (let wanted = reading.wanted(); wanted.length > 0; wanted = reading.wanted())
    for (const path of wanted) {
      const file = tree[path] ?? "";
      const bytes = typeof file === "string" ? encoder.encode(file) : file;
      // oxlint-disable-next-line no-await-in-loop -- one runtime at a time: the next boot follows the last one's end
      while (reading.give(path, bytes, parser) === "restart") parser = await boot();
    }
  return reading.result();
}
