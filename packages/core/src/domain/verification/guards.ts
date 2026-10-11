import {
  anchorPathsOf,
  type Proposition,
  type SubjectKey,
  subjectsNear,
} from "../coordination/index.ts";
import type { GuardId } from "../kernel/index.ts";
import type { AdmittedGuard, StepSpec } from "./flow.ts";

/** What selects a guard for a change: the subjects it touches or relies on, and the paths it touches. */
export type GuardExposure = {
  readonly subjects: readonly SubjectKey[];
  readonly touchedPaths: readonly string[];
};

/** A guard step and why the change is exposed to it. */
export type SelectedGuard = { readonly spec: StepSpec; readonly because: readonly string[] };

/** The step id a guard runs under. */
export const guardStepId = (guardId: GuardId): string => `guard:${guardId}`;

/**
 * Why the change is exposed to the tenet, by exposure's never-miss rule: a
 * subject near the tenet's (related or a sibling), or a touched path one of
 * its anchors pins. Empty when the change is not exposed.
 */
const exposedBy = (tenet: Proposition, change: GuardExposure): readonly string[] => {
  const anchored = anchorPathsOf([tenet]);
  return [
    ...change.subjects
      .filter((s) => subjectsNear(s, tenet.subject))
      .map((s) => `relies on or alters ${s}, near ${tenet.subject}`),
    ...change.touchedPaths
      .filter((p) => anchored.has(p))
      .map((p) => `edits ${p}, anchored by the tenet`),
  ];
};

const stepOf = (g: AdmittedGuard): StepSpec => ({
  id: guardStepId(g.guardId),
  version: g.probe,
  kind: "probe",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [g.tenet.proposition.subject] },
  reads: [],
  outcomes: ["pass", "fail", "abstain"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0, cpuMs: 30_000, tokens: 0 },
  determinism: "deterministic",
  suite: false,
  optional: false,
  guards: { predicate: g.tenet.proposition.predicate, probe: g.probe },
});

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The admitted guards a change runs, with why. A guard is a regression test,
 * so selecting it is test-impact analysis and must never miss: a guard
 * applies whenever the change is exposed to its tenet, siblings and anchored
 * edits included. Running a guard more often never blocks wrongly, because its
 * fail is proof whatever made it run. One step per guard, in step-id order.
 */
export const selectGuards = (
  admitted: readonly AdmittedGuard[],
  change: GuardExposure,
): readonly SelectedGuard[] => {
  const byId = new Map<string, SelectedGuard>();
  for (const g of admitted) {
    const because = exposedBy(g.tenet.proposition, change);
    const spec = stepOf(g);
    const seen = byId.get(spec.id);
    // A guard listed twice runs once; were its listings to disagree, the least probe hash wins, whatever the order.
    if (because.length > 0 && (seen === undefined || spec.version < seen.spec.version))
      byId.set(spec.id, { spec, because: [`guards tenet ${g.tenet.id}`, ...because] });
  }
  return [...byId.values()].toSorted((a, b) => byCodePoint(a.spec.id, b.spec.id));
};

/** The guard steps a change runs (see `selectGuards`). */
export const guardSteps = (
  admitted: readonly AdmittedGuard[],
  change: GuardExposure,
): readonly StepSpec[] => selectGuards(admitted, change).map((g) => g.spec);
