import { Result } from "effect";
import { type ChangeId, canBlock, matchesGlob } from "../kernel/index.ts";
import type { Intent } from "./change.ts";
import { compare } from "./compare.ts";
import type { DerivedEffect, Drift } from "./derivation.ts";
import type { GuardedTenet, HeldPremise } from "./graph.ts";
import type { FootprintEntry, Proposition } from "./proposition.ts";
import { readScope, scopeCovers } from "./scope.ts";
import { isAncestorOrSelf } from "./subject.ts";

/**
 * One gap between what a change declared and what Keel derived from its diff.
 * `drift` is the wire shape for DriftDetected; `blocks` and `opensConflict`
 * say what the gap does. Only proof or a ruling can block (ADR 0005).
 */
export type DriftFinding =
  | { readonly _tag: "footprint"; readonly drift: Drift; readonly paths: readonly string[]; readonly blocks: false; readonly opensConflict: false }
  | { readonly _tag: "undeclared-effect"; readonly drift: Drift; readonly effect: DerivedEffect; readonly blocks: boolean; readonly opensConflict: false }
  | {
      readonly _tag: "silent-retraction";
      readonly drift: Drift;
      readonly effect: DerivedEffect;
      readonly contradicts: readonly (HeldPremise | GuardedTenet)[];
      readonly blocks: boolean;
      readonly opensConflict: true;
    };

const scopeWithin = (outer: Proposition, inner: Proposition): boolean => {
  const o = readScope(outer.scope);
  const i = readScope(inner.scope);
  return Result.isSuccess(o) && Result.isSuccess(i) && scopeCovers(o.success, i.success);
};

/**
 * A derived effect is declared when some declared effect speaks for it: the
 * same predicate, on its subject or an ancestor, over at least its scope,
 * with a value the derived one stays inside. Derivation fills
 * `DerivedEffect.declared` from this.
 */
export const isDeclared = (intent: Intent, effect: Proposition): boolean =>
  (intent.declaredEffects ?? []).some((declared) => {
    const outcome = compare(declared, effect).outcome;
    return (
      declared.predicate === effect.predicate &&
      isAncestorOrSelf(declared.subject, effect.subject) &&
      scopeWithin(declared, effect) &&
      (outcome === "compatible" || outcome === "refines")
    );
  });

const undeclaredPaths = (intent: Intent, touched: readonly FootprintEntry[]): readonly string[] =>
  touched.map((t) => t.path).filter((path) => !intent.footprint.some((d) => matchesGlob(d.path, path)));

/**
 * The drift between `intent` and what the diff did: `touched` is the footprint
 * the diff actually has, `derived` the effects Keel derived from it.
 * - footprint drift (paths outside the declared footprint): a notice, never blocking
 * - an undeclared effect: a notice that blocks only when its evidence is proof or a ruling
 * - a silent retraction (an undeclared effect contradicting another change's
 *   `must` premise, or a tenet): opens a conflict at any class, blocks only as
 *   proof or a ruling
 */
export const drift = (
  self: ChangeId,
  intent: Intent,
  touched: readonly FootprintEntry[],
  derived: readonly DerivedEffect[],
  premises: readonly HeldPremise[],
  tenets: readonly GuardedTenet[],
): readonly DriftFinding[] => {
  const paths = undeclaredPaths(intent, touched);
  const footprint: readonly DriftFinding[] =
    paths.length === 0
      ? []
      : [
          {
            _tag: "footprint",
            drift: { class: "footprint", severity: "low", detail: `touched outside the declared footprint: ${paths.join(", ")}` },
            paths,
            blocks: false,
            opensConflict: false,
          },
        ];

  const effects = derived
    .filter((effect) => !isDeclared(intent, effect.proposition))
    .map((effect): DriftFinding => {
      const contradicts = (p: Proposition): boolean => compare(p, effect.proposition).outcome === "contradicts";
      const against = [
        ...premises.filter((p) => p.holder !== self && (p.proposition.strength ?? "must") === "must" && contradicts(p.proposition)),
        ...tenets.filter((t) => contradicts(t.proposition)),
      ];
      const blocks = canBlock(effect.evidenceClass);
      const what = `${effect.proposition.subject} ${effect.proposition.predicate} ${effect.proposition.relation} ${String(effect.proposition.value)}`;
      return against.length === 0
        ? {
            _tag: "undeclared-effect",
            drift: { class: "undeclared-effect", severity: "medium", detail: `undeclared: ${what} (${effect.evidenceClass})` },
            effect,
            blocks,
            opensConflict: false,
          }
        : {
            _tag: "silent-retraction",
            drift: {
              class: "silent-retraction",
              severity: "high",
              detail: `undeclared and contradicting ${against.length} relied-on claim(s): ${what} (${effect.evidenceClass})`,
            },
            effect,
            contradicts: against,
            blocks,
            opensConflict: true,
          };
    });
  return [...footprint, ...effects];
};
