import {
  makeAgentDirectoryMemory,
  makeClockMemory,
  makeIdsMemory,
  makeTokenIssuerMemory,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";

const clock = makeClockMemory().layer;
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    makeAgentDirectoryMemory().layer,
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    clock,
    makeIdsMemory().layer,
  ),
);
const run = makeRunner(runtime);
afterAll(() => runtime.dispose());

describe("a client abort interrupts the request's fiber (pitfall 4)", () => {
  it("stops the work at once, runs its finaliser, and answers 503", async () => {
    const abort = new AbortController();
    let released = false;
    const slow = Effect.acquireRelease(Effect.void, () =>
      Effect.sync(() => (released = true)),
    ).pipe(Effect.andThen(Effect.sleep("2 seconds")), Effect.as("finished"), Effect.scoped);
    const started = performance.now();
    setTimeout(() => abort.abort(), 20);
    const result = await run(
      { requestId: "req-abort", principal: null, signal: abort.signal },
      slow,
    );
    expect(result).toMatchObject({ status: 503, body: { code: "service.unavailable" } });
    expect(released).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
