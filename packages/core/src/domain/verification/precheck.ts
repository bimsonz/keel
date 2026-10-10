import { Result, Schema } from "effect";
import { Glob, matchesGlob, NextAction } from "../kernel/index.ts";

/**
 * Where guards are mounted into worlds. A change never edits a guard: guards
 * are admitted by Keel, from probes that proved a disagreement.
 */
export const GUARD_PATHS: readonly Glob[] = [Glob.make(".keel/guards/**")];

/** Why Precheck refused a path: it is a guard's, or the project protects it. */
export const PrecheckRule = Schema.Literals(["guard", "protected"]);
export type PrecheckRule = typeof PrecheckRule.Type;

/** A touched path Precheck refused, with the rule and the glob that caught it. */
export const RefusedPath = Schema.Struct({ path: Schema.String, rule: PrecheckRule, glob: Glob });
export type RefusedPath = typeof RefusedPath.Type;

/** A submission that touches guard or protected paths, and what the agent can do about it. */
export class PrecheckRefusal extends Schema.TaggedError<PrecheckRefusal>()("PrecheckRefusal", {
  paths: Schema.NonEmptyArray(RefusedPath),
  nextActions: Schema.NonEmptyArray(NextAction),
}) {}

/**
 * Precheck's policy, each fact from its one home: protected globs from the
 * project's settings, guard paths from `GUARD_PATHS`.
 */
export interface PrecheckPolicy {
  readonly protectedPaths: readonly Glob[];
  readonly guardPaths: readonly Glob[];
}

/** A submission Precheck lets through, with the paths it touched, deduplicated and sorted. */
export interface PrecheckPass {
  readonly touched: readonly string[];
}

type NonEmpty<A> = readonly [A, ...A[]];

const pathsOf = (refused: NonEmpty<RefusedPath>, rule: PrecheckRule): readonly string[] =>
  refused.filter((r) => r.rule === rule).map((r) => r.path);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One way forward per rule broken; each action carries the paths it is about in `args.paths`. */
const nextActionsFor = (refused: NonEmpty<RefusedPath>): NonEmpty<NextAction> => {
  const guard = pathsOf(refused, "guard");
  const protectedPaths = pathsOf(refused, "protected");
  const actions: NextAction[] = [];
  if (guard.length > 0)
    actions.push({
      kind: "call",
      title: `Push a commit that leaves ${plural(guard.length, "guard file", "guard files")} unchanged, then submit again: guards are admitted by Keel, never edited by a change`,
      operationId: "submit",
      args: { paths: guard },
    });
  if (protectedPaths.length > 0)
    actions.push(
      {
        kind: "call",
        title: `Push a commit that leaves ${plural(protectedPaths.length, "protected path", "protected paths")} unchanged, then submit again`,
        operationId: "submit",
        args: { paths: protectedPaths },
      },
      {
        kind: "escalate",
        title:
          "Ask an operator to change the project's protected paths, if this change must touch them",
        args: { paths: protectedPaths },
      },
    );
  const [first, ...rest] = actions;
  if (first === undefined) throw new Error("a refusal always breaks a rule");
  return [first, ...rest];
};

/**
 * Precheck's ruling on the paths a submission touches: refused if any is a
 * guard's or protected, citing exactly those paths (a guard path is cited as
 * a guard's even when it is also protected) with the next actions open to the
 * agent; otherwise passed. The input's order and duplicates never matter.
 */
export const precheck = (
  touchedPaths: readonly string[],
  policy: PrecheckPolicy,
): Result.Result<PrecheckPass, PrecheckRefusal> => {
  const touched = [...new Set(touchedPaths)].toSorted();
  const refused = touched.flatMap((path): RefusedPath[] => {
    const guard = policy.guardPaths.find((g) => matchesGlob(g, path));
    if (guard !== undefined) return [{ path, rule: "guard", glob: guard }];
    const protectedBy = policy.protectedPaths.find((g) => matchesGlob(g, path));
    return protectedBy === undefined ? [] : [{ path, rule: "protected", glob: protectedBy }];
  });
  const [first, ...rest] = refused;
  if (first === undefined) return Result.succeed({ touched });
  const paths: NonEmpty<RefusedPath> = [first, ...rest];
  return Result.fail(new PrecheckRefusal({ paths, nextActions: nextActionsFor(paths) }));
};
