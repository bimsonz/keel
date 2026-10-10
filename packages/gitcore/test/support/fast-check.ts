/**
 * fast-check, configured once for every property in this package. A plain
 * test run explores with a fresh seed (and prints the seed of any failure);
 * prove:red pins the seed with FC_SEED so a mutant is caught deterministically.
 */
import * as fc from "fast-check";

const seed = process.env["FC_SEED"];
const numRuns = process.env["FC_NUM_RUNS"];

fc.configureGlobal({
  numRuns: numRuns === undefined ? 300 : Number(numRuns),
  ...(seed === undefined ? {} : { seed: Number(seed) }),
});

export { fc };
