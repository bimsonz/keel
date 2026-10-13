import {
  makeAgentDirectoryMemory,
  makeChangesMemory,
  makeClockMemory,
  makeCodeHostMemory,
  makeAgentSignUpsMemory,
  makeEnrolmentsMemory,
  makeEventFeedMemory,
  makeProbeLedgerMemory,
  makeProbeStoreMemory,
  makeProjectViewsMemory,
  makeInboxMemory,
  makeIdsMemory,
  makeMembershipsMemory,
  makeNamespacesMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
  makeSessionsMemory,
  invitationsMemoryLayer,
  makeSponsorshipsMemory,
  makeStandingsMemory,
  makeTokenIssuerMemory,
  makeRepoServerMemory,
  makeLanesMemory,
  makeTrunksMemory,
  makeUsersMemory,
  makeOrgUsageMemory,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";

const clock = makeClockMemory().layer;
const directory = makeAgentDirectoryMemory().layer;
const inbox = makeInboxMemory();
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    makeOrgUsageMemory().layer,
    directory,
    makeProjectsMemory().layer,
    makeTrunksMemory().layer,
    makeLanesMemory().layer,
    makeRepoServerMemory({ repos: new Map() }).layer,
    makeEnrolmentsMemory().layer.pipe(Layer.provide(directory)),
    makeAgentSignUpsMemory().layer.pipe(Layer.provide(directory)),
    makeSessionsMemory().layer.pipe(Layer.provide(directory)),
    makeStandingsMemory().layer.pipe(Layer.provide(directory)),
    makeSponsorshipsMemory().layer.pipe(Layer.provide(directory)),
    invitationsMemoryLayer(),
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    clock,
    makeIdsMemory().layer,
    makeChangesMemory().layer,
    inbox.layer,
    inbox.notifier,
    makeEventFeedMemory().layer,
    makeProjectViewsMemory().layer,
    makeProbeStoreMemory().layer,
    makeProbeLedgerMemory().world,
    makeCodeHostMemory().layer,
    makeUsersMemory().layer,
    makeMembershipsMemory().layer,
    makeNamespacesMemory().layer,
    makeProjectNamespacesMemory().layer,
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
      { requestId: "req-abort", principal: { _tag: "Anonymous" }, signal: abort.signal },
      slow,
    );
    expect(result).toMatchObject({ status: 503, body: { code: "service.unavailable" } });
    expect(released).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("the line a request's defect leaves", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("[http.defect-line] names the defect a handler's effect died with, under the request id, and answers 500", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // What a held call is rejected with when the platform resets its object: the marks are the platform's.
    const defect = Object.assign(
      new Error("Durable Object reset because its code was updated.", {
        cause: new TypeError("storage is gone"),
      }),
      { durableObjectReset: true, retryable: true },
    );
    const result = await run(
      {
        requestId: "req-defect",
        principal: { _tag: "Anonymous" },
        signal: new AbortController().signal,
      },
      Effect.die(defect),
    );
    expect(result).toMatchObject({
      status: 500,
      body: { code: "internal.defect", detail: "Incident req-defect." },
    });
    // One argument, a string: an Error inside a logged object prints as `{}`.
    expect(error.mock.calls).toHaveLength(1);
    expect(error.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      ops: "defect",
      requestId: "req-defect",
      name: "Error",
      message: "Durable Object reset because its code was updated.",
      stack: defect.stack,
      cause: "TypeError: storage is gone",
      marks: ["durableObjectReset", "retryable"],
    });
  });
});
