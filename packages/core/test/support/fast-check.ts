/**
 * fast-check, configured once for every property in this package. Every
 * property in a file draws from one seed, so properties that play the same
 * plans share them (`memo`). A plain run draws that seed fresh and prints it
 * with any failure, and `FC_SEED=<seed>` replays the file; prove:red pins it
 * with FC_SEED so a mutant is caught deterministically.
 */
import * as fc from "fast-check";
import { vi } from "vitest";

const pinned = process.env["FC_SEED"];
const numRuns = process.env["FC_NUM_RUNS"];

/** The file's seed: FC_SEED's, or one drawn fresh for this run (a non-negative 31-bit integer, as fast-check's own). */
const seed =
  pinned === undefined
    ? (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) >>> 1
    : Number(pinned);

fc.configureGlobal({ numRuns: numRuns === undefined ? 300 : Number(numRuns), seed });

/**
 * Every file that imports `fc` is a property file: it plays hundreds of seeded
 * runs per property. Alone each takes a second or two, but inside the full
 * unit suite on a loaded runner some pass vitest's 5 s default, so property
 * files get the arch tests' 60 s limit instead of fewer runs (fewer runs would
 * weaken every mutant's proof).
 */
vi.setConfig({ testTimeout: 60_000 });

export { fc };
