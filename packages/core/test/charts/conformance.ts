/**
 * Checks a machine against its chart: every event a run folds must be an edge
 * of the chart (or a fact that leaves the state alone), and a tour of the real
 * machine must take every edge the chart draws.
 */
import { Result } from "effect";
import { IllegalTransition, type Instant } from "../../src/domain/kernel/index.ts";
import { type Fold, type Machine, stepsOf } from "../support/machine.ts";
import { type Chart, conforms, edgeKey, edgesOf } from "./chart-kit.ts";

type Rejection = { readonly _tag: string };
type Tagged = { readonly _tag: string };

/** Where a fold starts and ends, as the chart names its states. */
export interface View<S, E> {
  readonly from: (f: Fold<S, E>) => string;
  readonly to: (f: Fold<S, E>) => string;
}

/** Every decision's events, folded one at a time from the same state; refusals, and events evolve refuses, are skipped. */
export const foldsOf = <S, C, E, F>(
  machine: Machine<S, C, E, F>,
  before: S | undefined,
  results: readonly (Result.Result<readonly E[], Rejection> | undefined)[],
  at: Instant,
): readonly Fold<S, E>[] =>
  results.flatMap((result) => {
    if (result === undefined || Result.isFailure(result)) return [];
    try {
      return stepsOf(machine, before, result.success, at);
    } catch (error) {
      // decide-evolvable reports these; the chart judges only what evolve accepts.
      if (error instanceof IllegalTransition) return [];
      throw error;
    }
  });

/** Folds that leave the chart: a creation that does not land on its initial state, or a move it does not draw. */
export const offChart = <S, E extends Tagged>(
  chart: Chart,
  folds: readonly Fold<S, E>[],
  view: View<S, E>,
): readonly string[] => {
  const onChart = conforms(chart);
  return folds
    .filter((f) =>
      f.before === undefined
        ? view.to(f) !== chart.initial
        : !onChart(view.from(f), f.event._tag, view.to(f)),
    )
    .map((f) => edgeKey({ from: view.from(f), event: f.event._tag, to: view.to(f) }));
};

/** The chart's edges that no fold took. */
export const uncovered = <S, E extends Tagged>(
  chart: Chart,
  folds: readonly Fold<S, E>[],
  view: View<S, E>,
): readonly string[] => {
  const covered = new Set(
    folds
      .filter((f) => f.before !== undefined)
      .map((f) => edgeKey({ from: view.from(f), event: f.event._tag, to: view.to(f) })),
  );
  return edgesOf(chart)
    .map(edgeKey)
    .filter((e) => !covered.has(e));
};
