/**
 * fast-check, configured once for every property in this package. A plain
 * test run explores with a fresh seed (and prints the seed of any failure);
 * prove:red pins the seed with FC_SEED so a mutant is caught deterministically.
 */
import * as fc from "fast-check";
import { vi } from "vitest";

const seed = process.env["FC_SEED"];
const numRuns = process.env["FC_NUM_RUNS"];

fc.configureGlobal({
  numRuns: numRuns === undefined ? 300 : Number(numRuns),
  ...(seed === undefined ? {} : { seed: Number(seed) }),
});

/**
 * Every file that imports `fc` is a property file: it plays hundreds of seeded
 * runs per property. Alone each takes a second or two, but inside the full
 * unit suite on a loaded runner some pass vitest's 5 s default, so property
 * files get the arch tests' 60 s limit instead of fewer runs (fewer runs would
 * weaken every mutant's proof).
 */
vi.setConfig({ testTimeout: 60_000 });

/** Whether every property of this run draws from one pinned seed, and so draws the same plans. */
export const seedPinned = seed !== undefined;

export { fc };
