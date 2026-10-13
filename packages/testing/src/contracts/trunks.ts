import { describe, expect, it } from "@effect/vitest";
import type { CommitSha, ProjectId } from "@keeltown/core/kernel";
import { Trunks } from "@keeltown/core/ports";
import { Effect, type Layer, Option } from "effect";

/**
 * What the `Trunks` suite needs beside the port: a project whose trunk the
 * adapter is ready to initialize, and the head to name for it.
 */
export interface TrunksHarness {
  readonly layer: Layer.Layer<Trunks>;
  readonly fresh: () => Effect.Effect<{ readonly projectId: ProjectId; readonly head: CommitSha }>;
}

export function describeTrunksContract(adapter: string, make: () => TrunksHarness) {
  describe(`Trunks contract: ${adapter}`, () => {
    it.live(
      "[trunks.contract.view] a trunk with no head yet is shown as none, never a defect; once initialized it is shown at its head, idle, and moved when it was initialized",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const trunks = yield* Trunks;
          const { projectId, head } = yield* harness.fresh();
          expect(yield* trunks.view(projectId)).toEqual(Option.none());
          const before = Date.now();
          yield* trunks.initialize(projectId, head, "seed", { kind: "empty" });
          const after = Date.now();
          const shown = Option.getOrThrow(yield* trunks.view(projectId));
          expect({ head: shown.head, phase: shown.phase }).toEqual({ head, phase: "idle" });
          expect(shown.advancedAt).toBeGreaterThanOrEqual(before);
          expect(shown.advancedAt).toBeLessThanOrEqual(after);
          // Looking moves nothing: the next reader is shown the same trunk.
          expect(yield* trunks.view(projectId)).toEqual(Option.some(shown));
        }).pipe(Effect.provide(harness.layer));
      },
    );
    for (const method of ["initialize", "sync"]) it.todo(`Trunks.${method}`);
  });
}
