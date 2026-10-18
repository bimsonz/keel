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
  makeDecisionsMemory,
  makeProjectViewsMemory,
  makeInboxMemory,
  makeIdsMemory,
  makeMembershipsMemory,
  makeNamespacesMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
  makeSessionsMemory,
  invitationsMemoryLayer,
  makeIssuesMemory,
  makeSponsorshipsMemory,
  makeStandingsMemory,
  makeTokenIssuerMemory,
  makeRepoServerMemory,
  makeLanesMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  makeUsersMemory,
  makeNamespaceUsageMemory,
  deliveryMemoryLayer,
  makeVerdictsMemory,
  makePlanStoreMemory,
} from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { KEEL_BUSY } from "../../src/adapters/driving/http/problems.ts";
import { answerUnhandled, makeRunner } from "../../src/adapters/driving/http/run.ts";

const clock = makeClockMemory().layer;
const directory = makeAgentDirectoryMemory().layer;
const inbox = makeInboxMemory();
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    makeNamespaceUsageMemory().layer,
    directory,
    makeProjectsMemory().layer,
    makeTrunksMemory().layer,
    makeLanesMemory().layer,
    makeRepoServerMemory({ repos: new Map() }).layer,
    makeWorkspacePoolMemory().layer,
    makeEnrolmentsMemory().layer.pipe(Layer.provide(directory)),
    makeAgentSignUpsMemory().layer.pipe(Layer.provide(directory)),
    makeSessionsMemory().layer.pipe(Layer.provide(directory)),
    makeStandingsMemory().layer.pipe(Layer.provide(directory)),
    makeSponsorshipsMemory().layer.pipe(Layer.provide(directory)),
    invitationsMemoryLayer(),
    makeIssuesMemory().layer,
    deliveryMemoryLayer(),
    makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
    clock,
    makeIdsMemory().layer,
    makeChangesMemory().layer,
    inbox.layer,
    inbox.notifier,
    makeEventFeedMemory().layer,
    makeProjectViewsMemory().layer,
    makeDecisionsMemory().layer,
    makeVerdictsMemory().layer,
    makePlanStoreMemory().layer,
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
    // What an object's own code threw, as the platform hands it on: the mark is the platform's.
    const defect = Object.assign(
      new Error("Cannot read properties of undefined (reading 'lease')", {
        cause: new TypeError("storage is gone"),
      }),
      { remote: true },
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
      message: "Cannot read properties of undefined (reading 'lease')",
      stack: defect.stack,
      cause: "TypeError: storage is gone",
      marks: ["remote"],
    });
  });

  it("[http.object-busy] an object that could not take a call just now (overloaded, or restarted by a deploy) answers 503 with a wait, by the platform's marks or, past an object's RPC, by its sentence; logged apart from a defect", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const busy = [
      // Thrown by the platform at the call: its marks say so.
      Object.assign(new Error("Durable Object is overloaded. Requests queued for too long."), {
        overloaded: true,
      }),
      Object.assign(new Error("Durable Object reset because its code was updated."), {
        durableObjectReset: true,
        retryable: true,
      }),
      // The platform's mark alone, whatever it says.
      Object.assign(new Error("The object moved to another host."), { retryable: true }),
      Object.assign(new Error("Too many calls at once."), { overloaded: true }),
      // Past an object's RPC a defect is its name and message alone.
      new Error("Durable Object is overloaded. Too many requests queued."),
      new Error("Durable Object reset because its code was updated."),
      new Error("Your account is generating too much load on Durable Objects. Please back off."),
      // Wrapped by whoever caught it.
      new Error("declare failed", {
        cause: new Error("Durable Object is overloaded. Requests queued for too long."),
      }),
    ];
    for (const [n, defect] of busy.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, each logged in turn
      const result = await run(
        {
          requestId: `req-busy-${n}`,
          principal: { _tag: "Anonymous" },
          signal: new AbortController().signal,
        },
        Effect.die(defect),
      );
      expect(result).toMatchObject({
        status: 503,
        body: { code: "service.unavailable", detail: KEEL_BUSY, retryAfterMs: 2000 },
        headers: { "retry-after": 2 },
      });
      expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toMatchObject({
        ops: "object-busy",
        requestId: `req-busy-${n}`,
      });
    }
    // Thrown past every handler, in the gate, it answers the same.
    const thrown = answerUnhandled(busy[2], "req-gate", false);
    expect(thrown.status).toBe(503);
    expect(thrown.headers.get("retry-after")).toBe("2");
    // Anything else an object says is a defect: 500.
    const other = await run(
      {
        requestId: "req-other",
        principal: { _tag: "Anonymous" },
        signal: new AbortController().signal,
      },
      Effect.die(new Error("Durable Object storage is full")),
    );
    expect(other).toMatchObject({ status: 500, body: { code: "internal.defect" } });
  });
});
