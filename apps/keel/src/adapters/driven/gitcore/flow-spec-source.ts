import { FLOW_SPEC_PATH } from "@keeltown/core/application/verification";
import { CodeHost, FlowSpecSource, type RepoRef, type TreeEntry } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";

const SYMLINK = "120000";
const utf8 = new TextDecoder("utf-8");

/**
 * FlowSpecSource over CodeHost: one read of the base commit's tree gives the
 * root's paths, and `.keel/flow.json` and the root package.json are read as
 * UTF-8 text, when the commit holds them as plain files (a symlink is not
 * followed). A missing repo or commit fails as CodeHost does.
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
          const entries = yield* host.readTree(repo, base);
          const flowJson = yield* textAt(repo, entries, FLOW_SPEC_PATH);
          const packageJson = yield* textAt(repo, entries, "package.json");
          return {
            rootPaths: entries.filter((e) => !e.path.includes("/")).map((e) => e.path),
            ...(flowJson === undefined ? {} : { flowJson }),
            ...(packageJson === undefined ? {} : { packageJson }),
          };
        }),
    });
  }),
);
