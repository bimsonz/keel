import type { SourceFacts } from "@keeltown/core/domain/coordination";
import { CommitSha } from "@keeltown/core/kernel";
import {
  ObjectNotFound,
  type RepoRef,
  SyntaxSource,
  type SyntaxSkipped,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";

/** What a parser reports for a tree: its facts, before a commit is put on them. */
export type ParsedTree = Omit<SourceFacts, "commit">;

const SUPPORTED = /\.(ts|mts|cts|js)$/;

/**
 * SyntaxSource in memory: it parses nothing. Each tree is committed with the
 * facts a parser reports for it, and a reading answers those facts whole,
 * whatever the seeds; a seed is only checked against the tree, so one that is
 * not there is `absent` and one of another type `unsupported`.
 */
export function makeSyntaxSourceMemory() {
  const repo: RepoRef = { namespace: "memory", name: `syntax-source-${crypto.randomUUID()}` };
  const commits = new Map<
    string,
    { readonly paths: ReadonlySet<string>; readonly parsed: ParsedTree }
  >();
  return {
    commit: (files: Readonly<Record<string, string | Uint8Array>>, parsed: ParsedTree) =>
      Effect.sync(() => {
        const sha = CommitSha.make(
          [...crypto.getRandomValues(new Uint8Array(20))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        );
        commits.set(sha, { paths: new Set(Object.keys(files)), parsed });
        return { repo, sha };
      }),
    layer: Layer.succeed(
      SyntaxSource,
      SyntaxSource.of({
        facts: (at, commit, seeds) => {
          const held = at.name === repo.name ? commits.get(commit) : undefined;
          if (held === undefined) return Effect.fail(new ObjectNotFound({ repo: at, oid: commit }));
          const skipped = [...new Set(seeds)]
            .toSorted()
            .flatMap((path): SyntaxSkipped[] =>
              !held.paths.has(path)
                ? [{ path, reason: "absent" }]
                : SUPPORTED.test(path)
                  ? []
                  : [{ path, reason: "unsupported" }],
            );
          return Effect.succeed({
            // The fixture's facts carry a commit of their own; the reading's is the one asked for.
            facts: { ...held.parsed, commit },
            skipped,
            parser: "memory",
          });
        },
      }),
    ),
  };
}
