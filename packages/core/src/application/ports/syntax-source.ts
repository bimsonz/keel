import { Context, type Effect, Schema } from "effect";
import { SourceFacts } from "../../domain/coordination/index.ts";
import type { CommitSha } from "../../domain/kernel/index.ts";
import type { ObjectNotFound, RepoNotFound, RepoRef } from "./code-host.ts";

/**
 * Why a file was not read:
 * - `absent`: the path is not at that commit (a file the change adds has no base);
 * - `syntax-error`: the parse has an error node, so the file is skipped whole and never half-read;
 * - `unsupported`: not a `.ts`, `.mts`, `.cts` or `.js` file, not UTF-8, or not a regular file;
 * - `too-large`: over 512 KB;
 * - `beyond-cap`: the reading already held 400 files;
 * - `too-slow`: the parse passed its work budget;
 * - `unparseable`: the parse passed the parser's memory cap, or the file nests deeper than 500 levels.
 */
export const SyntaxSkipReason = Schema.Literals([
  "absent",
  "syntax-error",
  "unsupported",
  "too-large",
  "beyond-cap",
  "too-slow",
  "unparseable",
]);
export type SyntaxSkipReason = typeof SyntaxSkipReason.Type;

export const SyntaxSkipped = Schema.Struct({
  path: Schema.NonEmptyString,
  reason: SyntaxSkipReason,
});
export type SyntaxSkipped = typeof SyntaxSkipped.Type;

/** One commit's reading: its facts, the files left out and why, and the parser that read it. */
export const SyntaxReading = Schema.Struct({
  facts: SourceFacts,
  /** In path order. A derivation that rests on this reading records them: a skipped file's caches are not in the facts. */
  skipped: Schema.Array(SyntaxSkipped),
  /** The rules' version and the parser's packages: what a derivation record is stamped with. */
  parser: Schema.NonEmptyString,
});
export type SyntaxReading = typeof SyntaxReading.Type;

/**
 * No reading could be made, and asking again with the same input changes
 * nothing unless the reason is the parser's own:
 * - `too-many-seeds`: more than 400 seeds;
 * - `too-many-bytes`: the files read passed 8 MB together;
 * - `too-many-failures`: the parser gave up on four files (`too-slow`, `unparseable`);
 * - `parser-starting`: another call in this isolate is booting the parser; retry;
 * - `parser-failed`: the parser did not boot.
 */
export class SyntaxUnavailable extends Schema.TaggedError<SyntaxUnavailable>()(
  "SyntaxUnavailable",
  {
    reason: Schema.Literals([
      "too-many-seeds",
      "too-many-bytes",
      "too-many-failures",
      "parser-starting",
      "parser-failed",
    ]),
  },
) {}

/**
 * The parsed structure of a commit's source, for deterministic effect
 * derivation: stores, their reads, writes and removals,
 * the calls that reach them and the event handlers registered. It reports
 * structure and judges nothing; `deriveEffects` judges.
 *
 * **The path rule is the adapter's.** `facts` parses the `seeds` and follows
 * their relative imports to a fixpoint, breadth-first, up to 400 files. The
 * caller gives the files a change touches and the files that anchor the
 * subjects near them (`derivationSeeds`), at the base and again at the head;
 * it never lists a tree.
 *
 * **Names are resolved, never guessed.** A receiver's class is known only
 * from `new C()`, `this`, a declared type, or the declared return type of a
 * callee that itself resolved, through bindings that all agree. A call that
 * does not resolve is left out. A store is a binding given a `new Map`,
 * `Set`, `WeakMap` or `WeakSet`, held where it is bound.
 *
 * **What the facts do not see**, so a derivation must not read their silence
 * as proof:
 * - a session-keyed cache is told by a word in its key's names;
 * - a hop through a bare package, a computed import or a skipped file is
 *   missed, and the decision model then derives that effect as opinion;
 * - a read-modify-write on a primary store reads as a static cache, and only
 *   a change that introduces one is told so;
 * - code at a module's top level outside any declaration is not read, and a
 *   store bound in a function body is `local` even when a closure keeps it.
 */
export class SyntaxSource extends Context.Service<
  SyntaxSource,
  {
    /** A seed that is not at the commit is `skipped` as `absent`, never a failure. */
    readonly facts: (
      repo: RepoRef,
      commit: CommitSha,
      seeds: readonly string[],
    ) => Effect.Effect<SyntaxReading, RepoNotFound | ObjectNotFound | SyntaxUnavailable>;
  }
>()("keel/SyntaxSource") {}
