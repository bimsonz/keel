/**
 * The conflicts a run plants among its agents' tasks, on the fixture's own pure
 * functions, each kind with its decoy. A planted pair conflicts: one change
 * alters what the other's test relies on (effect), the two rely on contrary
 * premises (premise), or both rewrite the same lines (textual). A decoy looks
 * the same and does not conflict. Keel is never told which is which: the key
 * is written apart, and its digest is published before the run.
 *
 * There is no interaction kind here: it would remove a function the fixture's
 * own tests call, and verification would refuse that side on its own.
 */

import type { Case, Premise, Target } from "./tasks.ts";

export const PAIR_KINDS = ["premise", "effect", "textual"] as const;
export type PairKind = (typeof PAIR_KINDS)[number];

/** One side of a pair: a test to write under premises, or a change to make to a function's module. */
export type Side =
  | {
      readonly writes: "test";
      readonly target: Target;
      readonly cases: readonly Case[];
      readonly premises: readonly Premise[];
    }
  | { readonly writes: "change"; readonly target: Target; readonly change: string };

export interface Pair {
  readonly kind: PairKind;
  readonly planted: boolean;
  readonly a: Side;
  readonly b: Side;
}

/** A pair's entry in the sealed key: its two sides, by worker index. The scorer's own shape. */
export interface PairKey {
  readonly pair: number;
  readonly kind: PairKind;
  readonly planted: boolean;
  readonly a: number;
  readonly b: number;
}

const NAMES = "src/domain/names.ts";
const PERMISSIONS = "src/domain/permissions.ts";

const validator = (fn: string): Target => ({ module: NAMES, fn, answers: "validator" });
const predicate = (fn: string): Target => ({ module: PERMISSIONS, fn, answers: "predicate" });
const yes = (...args: (string | null)[]): Case => ({ args, expected: true });
const no = (...args: (string | null)[]): Case => ({ args, expected: false });

/** A subject key for this run: lowercase segments, so no two runs' premises meet. */
const subjectOf = (run: string, fn: string) =>
  ["swarm", run.toLowerCase().replace(/[^a-z0-9-]/g, "-"), fn].join(".");

/** A premise that `target` is pure, or may not be, anchored at its definition on trunk as the run began. */
function purity(run: string, base: string | undefined, target: Target, value: boolean): Premise {
  return {
    subject: subjectOf(run, target.fn),
    predicate: "purity",
    relation: "is",
    value,
    anchors: [
      { path: target.module, symbol: target.fn, ...(base === undefined ? {} : { commit: base }) },
    ],
    gloss: value ? `${target.fn}() has no side effects` : `${target.fn}() may have side effects`,
  };
}

const KEEP = "Keep every message and every answer exactly as they are.";

const change = (target: Target, what: string): Side => ({
  writes: "change",
  target,
  change: what,
});
const logs = (target: Target) =>
  change(
    target,
    `Make ${target.fn} log each call with console.info(${JSON.stringify(target.fn)}, ...its arguments) before it answers. ${KEEP}`,
  );
const rewrite = (target: Target, how: string) =>
  change(target, `Rewrite the body of ${target.fn} ${how}. ${KEEP}`);

/**
 * The pairs a run plants, in order: on the validators, each kind planted and
 * as a decoy; and, for a run of `wide` or more, one more planted pair of each
 * kind on the permission checks.
 */
export function pairsFor(options: {
  readonly run: string;
  readonly base: string | undefined;
  readonly wide: boolean;
}): Pair[] {
  const { run, base, wide } = options;
  const test = (target: Target, cases: readonly Case[], ...pure: boolean[]): Side => ({
    writes: "test",
    target,
    cases,
    premises: pure.map((value) => purity(run, base, target, value)),
  });
  const color = validator("checkColor");
  const password = validator("checkPassword");
  const sha = validator("checkSha");
  const username = validator("checkUsername");
  const branch = validator("checkBranch");
  const label = validator("checkLabel");
  const repoName = validator("checkRepoName");
  const pairs: Pair[] = [
    // One side makes the function impure; the other's test relies on its being pure.
    {
      kind: "effect",
      planted: true,
      a: logs(color),
      b: test(color, [yes("a1b2c3"), no("#a1b2c3")], true),
    },
    {
      kind: "effect",
      planted: false,
      a: rewrite(
        password,
        "so it reads value.length once into a local constant, with no side effect",
      ),
      b: test(password, [yes("x".repeat(10)), no("x".repeat(9))], true),
    },
    // Contrary premises on one subject, or the same premise twice.
    {
      kind: "premise",
      planted: true,
      a: test(sha, [yes("0".repeat(40))], true),
      b: test(sha, [no("g".repeat(40))], false),
    },
    {
      kind: "premise",
      planted: false,
      a: test(username, [yes("a")], true),
      b: test(username, [no("-octo")], true),
    },
    // The same lines of one function, or two functions of one file.
    {
      kind: "textual",
      planted: true,
      a: rewrite(branch, "as one if statement per rule, each returning its own message"),
      b: rewrite(
        branch,
        "so every rule is checked in a single combined condition before one return",
      ),
    },
    {
      kind: "textual",
      planted: false,
      a: rewrite(label, "so its pattern test is the last statement before the final return"),
      b: rewrite(repoName, "so its pattern test is the last statement before the final return"),
    },
  ];
  if (!wide) return pairs;
  const allows = predicate("allows");
  const canSee = predicate("canSee");
  const minimumRole = predicate("minimumRole");
  return [
    ...pairs,
    {
      kind: "effect",
      planted: true,
      a: logs(allows),
      b: test(allows, [yes(null, "read", "public"), no(null, "push", "public")], true),
    },
    {
      kind: "premise",
      planted: true,
      a: test(canSee, [yes(null, "public")], true),
      b: test(canSee, [no(null, "private")], false),
    },
    {
      kind: "textual",
      planted: true,
      a: rewrite(minimumRole, "as a lookup in a constant table"),
      b: rewrite(minimumRole, "as a switch with one case per action"),
    },
  ];
}
