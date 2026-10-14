import { Result } from "effect";
import type { ChangeId } from "../kernel/index.ts";
import { globsMayOverlap } from "../kernel/index.ts";
import { alternativesOf } from "./alternatives.ts";
import type { Intent } from "./change.ts";
import { readClaim } from "./claim.ts";
import { compare } from "./compare.ts";
import type { UnreadableProposition } from "./errors.ts";
import type { LiveChange } from "./graph.ts";
import type { Contradiction, ContradictionRole, Neighbour } from "./preflight.ts";
import type { Proposition, SubjectKey } from "./proposition.ts";
import { subjectsRelated, subjectsSiblings } from "./subject.ts";

/**
 * What preflight's `nearby` reports. Exposure may over-report (siblings, any
 * related subject, overlapping globs, shared anchors); it must never miss a
 * change that fallout could later reach.
 */
export type Exposure = {
  readonly neighbours: readonly Neighbour[];
  readonly contradictions: readonly Contradiction[];
  /** The intent's own propositions that do not read on their lattice: each becomes a notice with the grammar. */
  readonly unreadable: readonly UnreadableProposition[];
  /** The live changes with the same intent (`alternativesOf`), in the order given, never ranked. */
  readonly alternatives: readonly ChangeId[];
};

/** The paths the propositions' anchors pin. */
export const anchorPathsOf = (ps: readonly Proposition[]): ReadonlySet<string> =>
  new Set(ps.flatMap((p) => (p.anchors ?? []).map((a) => a.path)));

/** What exposure compares of an intent: its premises, then its declared effects. */
export const intentPropositions = (intent: Intent): readonly Proposition[] => [
  ...intent.premises,
  ...(intent.declaredEffects ?? []),
];

/** What exposure reads of a live change: its premises, its declared effects, then what was derived for it. */
export const livePropositions = (live: LiveChange): readonly Proposition[] => [
  ...live.intent.premises,
  ...(live.intent.declaredEffects ?? []),
  ...live.derived.map((d) => d.proposition),
];

/**
 * Exposure's never-miss relation between subjects: related (ancestor or
 * self, either way) or siblings. Wider than fallout's, which treats siblings
 * as proximity only, because exposure may over-report but must never miss.
 */
export const subjectsNear = (a: SubjectKey, b: SubjectKey): boolean =>
  subjectsRelated(a, b) || subjectsSiblings(a, b);

export const exposure = (
  self: ChangeId,
  intent: Intent,
  liveChanges: readonly LiveChange[],
): Exposure => {
  const myPremises = intent.premises;
  const myEffects = intent.declaredEffects ?? [];
  const mine = intentPropositions(intent);
  const myAnchors = anchorPathsOf(mine);
  const neighbours: Neighbour[] = [];
  const contradictions: Contradiction[] = [];

  for (const live of liveChanges.filter((l) => l.id !== self)) {
    const theirPremises = live.intent.premises;
    const theirEffects = [
      ...(live.intent.declaredEffects ?? []),
      ...live.derived.map((d) => d.proposition),
    ];
    const theirs = livePropositions(live);

    const subjects = [
      ...new Set(
        theirs
          .filter((t) => mine.some((m) => subjectsNear(m.subject, t.subject)))
          .map((t) => t.subject),
      ),
    ];
    const sharedAnchor = [...anchorPathsOf(theirs)].some((path) => myAnchors.has(path));
    const footprint = intent.footprint.some((m) =>
      live.intent.footprint.some((t) => globsMayOverlap(m.path, t.path)),
    );
    if (subjects.length > 0 || sharedAnchor || footprint) {
      neighbours.push({
        changeId: live.id,
        goal: live.intent.goal,
        subjects: subjects.toSorted(),
        overlap: subjects.length > 0 ? "subject" : "footprint",
      });
    }

    const pairs: readonly (readonly [Proposition, Proposition, ChangeId, ContradictionRole])[] = [
      ...myPremises.flatMap((p) => [
        ...theirPremises.map((t) => [p, t, self, "premise"] as const),
        ...theirEffects.map((t) => [p, t, self, "effect"] as const),
      ]),
      ...theirPremises.flatMap((p) => myEffects.map((e) => [p, e, live.id, "effect"] as const)),
    ];
    for (const [premise, other, holder, withRole] of pairs) {
      if (compare(premise, other).outcome === "contradicts")
        contradictions.push({ premise, with: other, holder, withRole });
    }
  }

  const unreadable = [
    ...myPremises.map((p) => readClaim(p, "premise")),
    ...myEffects.map((e) => readClaim(e)),
  ].flatMap((read) => (Result.isFailure(read) ? [read.failure] : []));
  return {
    neighbours,
    contradictions,
    unreadable,
    alternatives: alternativesOf(self, intent, liveChanges),
  };
};
