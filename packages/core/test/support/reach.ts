/**
 * A property that counts what its draws reached, asserted so that the count
 * has a floor which never changes. A plain run explores with a fresh seed, so
 * a count taken inside a property is a different number every time: a branch
 * the generator reaches a few times in a run is, now and then, reached by none
 * of its draws, and the check that it was reached fails with nothing wrong.
 * What a generator can reach is a fact about the generator. So the property is
 * asserted twice: under the run's own seed, to explore, and over draws that
 * are the same on every run, which is where the count's floor comes from.
 */
import { fc } from "./fast-check.ts";

/** Any fixed number: it only has to be the same on every run. */
const REACH_SEED = 20261013;
/** Pinned beside the seed, so the floor does not move with `FC_NUM_RUNS`. */
const REACH_DRAWS = 300;

export const assertReaching = <Ts>(property: fc.IProperty<Ts>): void => {
  fc.assert(property);
  fc.assert(property, { seed: REACH_SEED, numRuns: REACH_DRAWS });
};
