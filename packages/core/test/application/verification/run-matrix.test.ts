import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MATRIX_WORLDS,
  type ProbeRun,
  runMatrix,
} from "../../../src/application/verification/index.ts";
import { ContentHash } from "../../../src/domain/kernel/index.ts";
import { admit, type ProbeOutcome, type World } from "../../../src/domain/verification/index.ts";
import { ProbeRunner, type ProbeRunRequest } from "../../../src/application/ports/index.ts";
import { fc } from "../../support/fast-check.ts";

const hash = (n: number) =>
  Schema.decodeUnknownSync(ContentHash)(`sha256:${String(n).padStart(64, "0")}`);
const PROBE = hash(1);
const BUNDLES: Readonly<Record<World, ContentHash>> = {
  trunk: hash(10),
  A: hash(11),
  B: hash(12),
  AB: hash(13),
  "A-noop": hash(14),
};

type Answer = ProbeOutcome | "harness";
const ran = (outcome: ProbeOutcome): ProbeRun => ({
  _tag: "ran",
  outcome,
  reason: outcome,
  observations: [],
});

/** Runs the matrix on a runner that answers `answer(world, run)`, recording every request. */
const matrix = (answer: (world: World, run: number) => Answer) => {
  const requests: ProbeRunRequest[] = [];
  const layer = Layer.succeed(
    ProbeRunner,
    ProbeRunner.of({
      run: (request) =>
        Effect.sync(() => {
          requests.push(request);
          const a = answer(request.world, request.run);
          return a === "harness"
            ? {
                _tag: "harness-error" as const,
                reason: `broken in ${request.world}`,
                observations: [],
              }
            : ran(a);
        }),
    }),
  );
  return Effect.runPromise(runMatrix(PROBE, BUNDLES).pipe(Effect.provide(layer))).then((r) => ({
    ...r,
    requests,
  }));
};

/** S-1's freshness probe: n/a where the revoke route is absent, pass in A, fail in AB and in A-noop. */
const S1: Readonly<Record<World, ProbeOutcome>> = {
  trunk: "n/a",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};

describe("running a probe across the world matrix", () => {
  it("[world-matrix.noop-cell] runs every world, A-noop included, three times, so a discriminating probe is admitted", async () => {
    const { cells, harnessErrors, requests } = await matrix((w) => S1[w]);
    expect(harnessErrors).toEqual([]);
    expect(requests).toHaveLength(MATRIX_WORLDS.length * 3);
    expect(new Set(requests.map((r) => `${r.world}@${r.run}`)).size).toBe(15);
    expect(requests.every((r) => r.probe === PROBE && r.worldBundle === BUNDLES[r.world])).toBe(
      true,
    );
    expect(admit(cells)).toEqual({ _tag: "admitted", runs: 3 });
    // A probe that still passes with A's call removed proves nothing about it.
    const vacuous = await matrix((w) => (w === "A-noop" ? "pass" : S1[w]));
    expect(admit(vacuous.cells)).toEqual({ _tag: "rejected", reason: "non-discriminating" });
  });

  it("[world-matrix.harness-not-cell] keeps a harness error out of the cells, so a broken probe never completes a run", async () => {
    const { cells, harnessErrors } = await matrix((w, run) =>
      w === "AB" && run === 2 ? "harness" : S1[w],
    );
    expect(harnessErrors).toEqual([{ world: "AB", run: 2, reason: "broken in AB" }]);
    expect(cells.some((c) => c.world === "AB" && c.run === 2)).toBe(false);
    expect(admit(cells)).toEqual({ _tag: "pending", complete: 2 });
  });

  it("[world-matrix.cells-as-reported] turns exactly what each run reported into a cell, and every harness error into an error", async () => {
    const answerArb = fc.constantFrom<Answer>("pass", "fail", "n/a", "harness");
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(answerArb, answerArb, answerArb, answerArb, answerArb), {
          minLength: 3,
          maxLength: 3,
        }),
        async (script) => {
          const at = (w: World, run: number): Answer =>
            script[run - 1]?.[MATRIX_WORLDS.indexOf(w)] ?? "harness";
          const { cells, harnessErrors } = await matrix(at);
          const expected = [1, 2, 3].flatMap((run) =>
            MATRIX_WORLDS.flatMap((world) => {
              const a = at(world, run);
              return a === "harness" ? [] : [{ world, run, outcome: a }];
            }),
          );
          expect(cells).toEqual(expected);
          expect(harnessErrors.length + cells.length).toBe(15);
        },
      ),
      { numRuns: 100 },
    );
  });
});
