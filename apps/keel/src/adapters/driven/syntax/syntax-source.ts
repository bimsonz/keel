import { DEFAULT_VOCABULARY } from "@keeltown/core/domain/coordination";
import { CodeHost, SyntaxSource, SyntaxUnavailable } from "@keeltown/core/ports";
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

/**
 * SyntaxSource over CodeHost and tree-sitter: one read of the commit's tree,
 * then the seeds' blobs and, level by level, the blobs their relative imports
 * name. `@keeltown/syntax` decides which files those are, what each says and
 * when to stop; this adapter only fetches.
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
            const blobs = new Map<string, { readonly oid: string; readonly kind: PathKind }>();
            for (const entry of yield* host.readTree(repo, commit))
              if (entry.type !== "tree")
                blobs.set(entry.path, {
                  oid: entry.oid,
                  kind:
                    entry.type === "blob" && (entry.mode === MODE_FILE || entry.mode === MODE_EXEC)
                      ? "file"
                      : "other",
                });
            let parser = yield* boot;
            const reading = openReading(seeds, (path) => blobs.get(path)?.kind, registrars);
            for (let wanted = reading.wanted(); wanted.length > 0; wanted = reading.wanted()) {
              const level = yield* Effect.forEach(
                wanted,
                (path) =>
                  Effect.map(host.readBlob(repo, blobs.get(path)?.oid ?? ""), (bytes) => ({
                    path,
                    bytes,
                  })),
                { concurrency: 8 },
              );
              for (const file of level)
                while (reading.give(file.path, file.bytes, parser) === "restart")
                  parser = yield* boot;
            }
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
