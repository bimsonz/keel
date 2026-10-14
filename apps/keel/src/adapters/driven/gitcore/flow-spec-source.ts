import { FLOW_SPEC_PATH } from "@keeltown/core/application/verification";
import { CodeHost, FlowSpecSource, type RepoRef, type TreeEntry } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";

const SYMLINK = "120000";
const KEEL_DIR = ".keel";
const utf8 = new TextDecoder("utf-8");

/**
 * FlowSpecSource over CodeHost: the base commit's root listing gives the
 * root's paths and the root package.json, and `.keel`'s listing, read only
 * when the root holds `.keel` as a directory, gives `.keel/flow.json`. Each
 * file is read as UTF-8 text when the commit holds it as a plain file (a
 * symlink is not followed). Nothing else of the tree is read, so a read costs
 * the same whatever the repo's size. A missing repo or commit fails as
 * CodeHost does.
 */
export const FlowSpecSourceCodeHost = Layer.effect(
  FlowSpecSource,
  Effect.gen(function* () {
    const host = yield* CodeHost;
    const textAt = (repo: RepoRef, entries: readonly TreeEntry[], path: string) => {
      const entry = entries.find((e) => e.path === path && e.type === "blob" && e.mode !== SYMLINK);
      return entry === undefined
        ? Effect.succeed(undefined)
        : Effect.map(host.readBlob(repo, entry.oid), (bytes) => utf8.decode(bytes));
    };
    return FlowSpecSource.of({
      read: (repo, base) =>
        Effect.gen(function* () {
          const root = yield* host.listDir(repo, base, "");
          const keel = root.some((e) => e.path === KEEL_DIR && e.type === "tree")
            ? yield* host.listDir(repo, base, KEEL_DIR)
            : [];
          const flowJson = yield* textAt(repo, keel, FLOW_SPEC_PATH);
          const packageJson = yield* textAt(repo, root, "package.json");
          return {
            rootPaths: root.map((e) => e.path),
            ...(flowJson === undefined ? {} : { flowJson }),
            ...(packageJson === undefined ? {} : { packageJson }),
          };
          // The root is always a directory, and `.keel` is listed only once the root shows it as one.
        }).pipe(Effect.catchTag("PathNotFound", Effect.die)),
    });
  }),
);
