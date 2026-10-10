import type { ChangeId } from "../kernel/index.ts";
import { type Comparison, compare } from "./compare.ts";
import type { DerivedEffect } from "./derivation.ts";
import type { GuardedTenet, HeldPremise } from "./graph.ts";
import type { Proposition } from "./proposition.ts";
import { readScope, scopesIntersect } from "./scope.ts";
import { subjectsRelated, subjectsSiblings } from "./subject.ts";

export type FalloutTarget =
  | { readonly _tag: "premise"; readonly premise: HeldPremise }
  | { readonly _tag: "tenet"; readonly tenet: GuardedTenet };

export type NotifyReason =
  | "subject-touched"
  | "scope-disjoint"
  | "sibling-subject"
  | "shared-anchor";

/**
 * How a derived effect spreads to what relied on it.
 * - conflict: a same-key contradiction with intersecting scope, against a
 *   `must` premise or a tenet. A silent retraction when the change did not
 *   declare the effect.
 * - suspect: the effect speaks to the premise's clause but the lattice cannot
 *   show it broken (compatible, refines, needs a probe), or it contradicts a
 *   `should` premise. The holder is asked to re-affirm or revise.
 * - notify: proximity only. It never opens a conflict.
 */
export type Fallout =
  | {
      readonly _tag: "conflict";
      readonly target: FalloutTarget;
      readonly kind: "semantic";
      readonly silentRetraction: boolean;
      readonly comparison: Comparison;
    }
  | { readonly _tag: "suspect"; readonly target: FalloutTarget; readonly comparison: Comparison }
  | { readonly _tag: "notify"; readonly target: FalloutTarget; readonly reason: NotifyReason };

const anchorPaths = (p: Proposition): readonly string[] => (p.anchors ?? []).map((a) => a.path);

/** Scopes that do not read are treated as meeting: proximity may over-report, never under-report. */
const wireScopesIntersect = (a: Proposition, b: Proposition): boolean => {
  const sa = readScope(a.scope);
  const sb = readScope(b.scope);
  return sa._tag === "Failure" || sb._tag === "Failure" || scopesIntersect(sa.success, sb.success);
};

const proximity = (relied: Proposition, effect: Proposition): NotifyReason | undefined => {
  if (subjectsRelated(relied.subject, effect.subject)) {
    return wireScopesIntersect(relied, effect) ? "subject-touched" : "scope-disjoint";
  }
  if (subjectsSiblings(relied.subject, effect.subject)) return "sibling-subject";
  const paths = anchorPaths(effect);
  return anchorPaths(relied).some((path) => paths.includes(path)) ? "shared-anchor" : undefined;
};

const classify = (
  target: FalloutTarget,
  relied: Proposition,
  effect: DerivedEffect,
  binding: boolean,
): Fallout | undefined => {
  const comparison = compare(relied, effect.proposition);
  switch (comparison.outcome) {
    case "contradicts":
      return binding
        ? {
            _tag: "conflict",
            target,
            kind: "semantic",
            silentRetraction: !effect.declared,
            comparison,
          }
        : { _tag: "suspect", target, comparison };
    case "compatible":
    case "refines":
    case "needs-probe":
      return { _tag: "suspect", target, comparison };
    default: {
      const reason = proximity(relied, effect.proposition);
      return reason === undefined ? undefined : { _tag: "notify", target, reason };
    }
  }
};

/**
 * Every live premise (other than those of the change that made the effect)
 * and every tenet the effect reaches, with how it reaches them.
 */
export const fallout = (
  change: ChangeId,
  effect: DerivedEffect,
  premises: readonly HeldPremise[],
  tenets: readonly GuardedTenet[],
): readonly Fallout[] => [
  ...premises
    .filter((premise) => premise.holder !== change)
    .flatMap((premise) => {
      const binding = (premise.proposition.strength ?? "must") === "must";
      return classify({ _tag: "premise", premise }, premise.proposition, effect, binding) ?? [];
    }),
  ...tenets.flatMap(
    (tenet) => classify({ _tag: "tenet", tenet }, tenet.proposition, effect, true) ?? [],
  ),
];
