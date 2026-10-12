import { Effect } from "effect";
import type { ContentHash, Json } from "../../domain/kernel/index.ts";
import { ADMISSION_RUNS, type ProbeCell, type World } from "../../domain/verification/index.ts";
import { EvidenceStore, ProbeRunner } from "../ports/index.ts";
import { MATRIX_WORLDS } from "./world-matrix.ts";

/**
 * A cell with the reason the probe gave for it (the text a failure identical
 * in every world is fed back as) and what it observed on the way.
 */
export interface MatrixCell extends ProbeCell {
  readonly reason: string;
  readonly observations: readonly string[];
}

/** A cell as its evidence document: what the probe reported, in that world, on that run. */
export const cellEvidence = (cell: MatrixCell): Json => ({
  world: cell.world,
  run: cell.run,
  outcome: cell.outcome,
  reason: cell.reason,
  observations: [...cell.observations],
});

/** Stores a cell's evidence and answers its hash, the `resultRef` the cell's ProbeRan cites. */
export const storeCell = Effect.fn("verification/storeCell")(function* (cell: MatrixCell) {
  return yield* (yield* EvidenceStore).put(cellEvidence(cell));
});

/** A run the probe's harness broke on: never a cell, and the deterministic text a repair is given. */
export interface MatrixHarnessError {
  readonly world: World;
  readonly run: number;
  readonly reason: string;
}

/**
 * Runs a probe across the world matrix: every world in MATRIX_WORLDS, A-noop
 * included, on each calibration run 1..`runs`, each on its own fresh isolate.
 * A run's worlds go at once, the runs one after another. What the probe
 * reported becomes a cell for core's `admit`; a harness error is kept apart,
 * so a broken probe can never complete a run, let alone be admitted.
 */
export const runMatrix = Effect.fn("verification/runMatrix")(function* (
  probe: ContentHash,
  worlds: Readonly<Record<World, ContentHash>>,
  runs: number = ADMISSION_RUNS,
) {
  const runner = yield* ProbeRunner;
  const cells: MatrixCell[] = [];
  const harnessErrors: MatrixHarnessError[] = [];
  for (let run = 1; run <= runs; run++) {
    const answers = yield* Effect.forEach(
      MATRIX_WORLDS,
      (world) =>
        runner
          .run({ probe, world, worldBundle: worlds[world], run })
          .pipe(Effect.map((answer) => ({ world, answer }))),
      { concurrency: "unbounded" },
    );
    for (const { world, answer } of answers) {
      if (answer._tag === "ran")
        cells.push({
          world,
          run,
          outcome: answer.outcome,
          reason: answer.reason,
          observations: answer.observations,
        });
      else harnessErrors.push({ world, run, reason: answer.reason });
    }
  }
  return { cells, harnessErrors };
});
