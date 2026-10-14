import { DEFAULT_VOCABULARY } from "@keeltown/core/domain/coordination";
import { CodeHost, SyntaxSource, SyntaxUnavailable, type TreeEntry } from "@keeltown/core/ports";
import {
  bootParser,
  openReading,
  ParserStarting,
  type PathKind,
  type SourceParser,
  type SyntaxWasm,
} from "@keeltown/syntax";
import { Effect, Layer, Schedule } from "effect";

const MODE_FILE = "100644";
const MODE_EXEC = "100755";
/** How many directories are listed at once. */
const LISTINGS = 8;

type Blob = { readonly oid: string; readonly kind: PathKind };
/** One directory as listed: its blobs by path, and the paths of its subdirectories. */
type Listing = { readonly blobs: ReadonlyMap<string, Blob>; readonly trees: ReadonlySet<string> };
const EMPTY: Listing = { blobs: new Map(), trees: new Set() };

/** The directory a path is in: `""` for one at the root. */
const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** A directory's entries: each blob a regular file or something other, and each subdirectory. */
const listingOf = (entries: readonly TreeEntry[]): Listing => {
  const blobs = new Map<string, Blob>();
  const trees = new Set<string>();
  for (const entry of entries)
    if (entry.type === "tree") trees.add(entry.path);
    else
      blobs.set(entry.path, {
        oid: entry.oid,
        kind:
          entry.type === "blob" && (entry.mode === MODE_FILE || entry.mode === MODE_EXEC)
            ? "file"
            : "other",
      });
  return { blobs, trees };
};

/**
 * SyntaxSource over CodeHost and tree-sitter: the seeds' directories, then
 * the seeds' blobs and, level by level, the directories of the paths the
 * level's imports may name and the blobs they do name, each level's blobs in
 * one `readBlobs`. Never the whole tree: a directory is listed once a call,
 * up to eight at a time, and one the commit lacks lists as empty, so what it
 * would hold is absent. One that a directory listed above it shows absent is
 * not asked for at all. `@keeltown/syntax` decides which files those are,
 * which paths it will ask about, what each says and when to stop; this
 * adapter only fetches.
 *
 * The parser is static Wasm in this Worker: it reads repo text and runs none
 * of it. Only a parser that has finished booting is kept between calls, by
 * `@keeltown/syntax`, and never a pending promise. A boot costs a few
 * milliseconds once the Wasm is compiled, so each call asks for the parser
 * itself, and one that finds another call's boot under way waits a few
 * milliseconds and asks again. A file that kills the parser's runtime is
 * skipped and the runtime rebuilt; four such files end the call.
 *
 * `registrars` are the method names that register an event handler: a
 * project's vocabulary, Keel's by default.
 */
export const SyntaxSourceTreeSitter = (
  wasm: SyntaxWasm,
  registrars: readonly string[] = DEFAULT_VOCABULARY.registrars,
) =>
  Layer.effect(
    SyntaxSource,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      const boot: Effect.Effect<SourceParser, SyntaxUnavailable> = Effect.tryPromise({
        try: () => bootParser(wasm),
        catch: (error) => error,
      }).pipe(
        Effect.retry({
          while: (error) => error instanceof ParserStarting,
          schedule: Schedule.spaced("5 millis"),
          times: 200,
        }),
        Effect.mapError(
          (error) =>
            new SyntaxUnavailable({
              reason: error instanceof ParserStarting ? "parser-starting" : "parser-failed",
            }),
        ),
      );
      return SyntaxSource.of({
        facts: (repo, commit, seeds) =>
          Effect.gen(function* () {
            const listings = new Map<string, Listing>();
            /** Whether the nearest listed directory above `dir` holds no directory on the way to it. */
            const knownAbsent = (dir: string): boolean => {
              for (let below = dir; below !== ""; below = directoryOf(below)) {
                const above = listings.get(directoryOf(below));
                if (above !== undefined) return !above.trees.has(below);
              }
              return false;
            };
            /**
             * Lists the directories of `paths` not yet listed. One that a
             * listed directory above it shows absent, or that the commit
             * lacks, lists as empty.
             */
            const list = (paths: readonly string[]) =>
              Effect.suspend(() => {
                const asked: string[] = [];
                for (const dir of new Set(paths.map(directoryOf))) {
                  if (listings.has(dir)) continue;
                  if (knownAbsent(dir)) listings.set(dir, EMPTY);
                  else asked.push(dir);
                }
                return Effect.forEach(
                  asked,
                  (dir) =>
                    host.listDir(repo, commit, dir).pipe(
                      Effect.map(listingOf),
                      Effect.catchTag("PathNotFound", () => Effect.succeed(EMPTY)),
                      Effect.map((listing) => void listings.set(dir, listing)),
                    ),
                  { concurrency: LISTINGS, discard: true },
                );
              });
            const blobAt = (path: string): Blob | undefined => {
              const listing = listings.get(directoryOf(path));
              if (listing === undefined)
                throw new Error(`${path} was asked about before its directory was listed`);
              return listing.blobs.get(path);
            };
            yield* list(seeds);
            let parser = yield* boot;
            const reading = openReading(seeds, (path) => blobAt(path)?.kind, registrars);
            for (let wanted = reading.wanted(); wanted.length > 0; wanted = reading.wanted()) {
              const level = yield* host.readBlobs(
                repo,
                wanted.map((path) => blobAt(path)?.oid ?? ""),
              );
              for (const [at, read] of level.entries()) {
                const bytes = yield* Effect.fromResult(read);
                while (reading.give(wanted[at] ?? "", bytes, parser) === "restart")
                  parser = yield* boot;
              }
              yield* list(reading.lookups());
            }
            yield* list(reading.lookups());
            const result = reading.result();
            if ("unavailable" in result)
              return yield* Effect.fail(new SyntaxUnavailable({ reason: result.unavailable }));
            return {
              facts: { commit, ...result.facts },
              skipped: result.skipped,
              parser: parser.version,
            };
          }),
      });
    }),
  );
