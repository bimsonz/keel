import { describe, expect, it } from "@effect/vitest";
import { VerifierUnavailable } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { ProbeRunner, type ProbeRunRequest } from "@keeltown/core/ports";
import { sampleNamespace } from "@keeltown/testing";
import { Effect, Exit, Schema } from "effect";
import {
  encodeExit as encodeVerifierExit,
  type ProbeRunReply,
  ProbeRunRequest as VerifierProbeRunRequest,
  VerifierCodecs as KeelVerifyCodecs,
  type WorldReadiness,
  WorldReadyRequest as VerifierWorldReadyRequest,
} from "../../../keel-verify/src/rpc/index.ts";
import {
  ProbeRunnerRpc,
  verifierEntrypoint,
} from "../../src/adapters/driven/do-rpc/probe-runner.ts";
import type { VerifierEntrypoint } from "../../src/rpc/index.ts";

const hash = (n: number) => ContentHash.make(`sha256:${String(n).padStart(64, "0")}`);
const REQUEST: ProbeRunRequest = {
  namespace: sampleNamespace,
  probe: hash(1),
  world: "A-noop",
  worldBundle: hash(2),
  run: 3,
};

/** keel-verify's entrypoint, answering with keel-verify's own codec: the other copy of the contract. */
function verifier(
  answer: () => Exit.Exit<ProbeRunReply, VerifierUnavailable> | "throw",
  readiness: () => Exit.Exit<WorldReadiness, VerifierUnavailable> | "throw" = () => "throw",
) {
  const received: unknown[] = [];
  const asked: unknown[] = [];
  return {
    received,
    asked,
    entrypoint: {
      runProbe: async (request: unknown) => {
        received.push(request);
        const exit = answer();
        if (exit === "throw") throw new Error("Network connection lost.");
        return encodeVerifierExit(KeelVerifyCodecs.runProbe, exit);
      },
      worldReady: async (request: unknown) => {
        asked.push(request);
        const exit = readiness();
        if (exit === "throw") throw new Error("Network connection lost.");
        return encodeVerifierExit(KeelVerifyCodecs.worldReady, exit);
      },
      buildDeps: async (): Promise<unknown> => {
        throw new Error("no probe run builds deps");
      },
    },
  };
}

/** keel-verify's entrypoint answering both questions with `raw`, whatever it is. */
const answering = (raw: unknown): VerifierEntrypoint => ({
  runProbe: async () => raw,
  worldReady: async () => raw,
  buildDeps: async (): Promise<unknown> => {
    throw new Error("no probe run builds deps");
  },
});

/** Answers that are not a run's or a world's: no Exit at all, or an Exit of something else. */
const NOT_ANSWERS: readonly unknown[] = [
  undefined,
  null,
  "ran",
  {},
  { _tag: "Success" },
  { _tag: "Success", value: { run: { _tag: "ran", outcome: "maybe" }, queued: true } },
  { _tag: "Success", value: { _tag: "Unready" } },
  { _tag: "Failure", cause: "the box fell over" },
];

const run = (entrypoint: VerifierEntrypoint) =>
  Effect.gen(function* () {
    return yield* (yield* ProbeRunner).run(REQUEST);
  }).pipe(Effect.provide(ProbeRunnerRpc(entrypoint)));

const ready = (entrypoint: VerifierEntrypoint) =>
  Effect.gen(function* () {
    return yield* (yield* ProbeRunner).ready({
      namespace: REQUEST.namespace,
      worldBundle: REQUEST.worldBundle,
    });
  }).pipe(Effect.provide(ProbeRunnerRpc(entrypoint)));

describe("ProbeRunner over keel-verify's runProbe", () => {
  it.effect(
    "[probe-runner.rpc-ran] sends a request keel-verify decodes, and answers the run it reports",
    () => {
      const v = verifier(() =>
        Exit.succeed({
          run: {
            _tag: "ran",
            outcome: "fail",
            reason: "bob DELETE -> 204 (expected 403)",
            observations: ["[probe] x"],
          },
          queued: true,
          instance: "i-1",
        }),
      );
      return Effect.gen(function* () {
        expect(yield* run(v.entrypoint)).toEqual({
          _tag: "ran",
          outcome: "fail",
          reason: "bob DELETE -> 204 (expected 403)",
          observations: ["[probe] x"],
        });
        expect(Schema.decodeUnknownSync(VerifierProbeRunRequest)(v.received[0])).toEqual(REQUEST);
      });
    },
  );

  it.effect("[probe-runner.rpc-ran] answers a harness error as the run it is", () => {
    const v = verifier(() =>
      Exit.succeed({
        run: { _tag: "harness-error", reason: "two tests", observations: [] },
        queued: false,
      }),
    );
    return Effect.gen(function* () {
      expect(yield* run(v.entrypoint)).toEqual({
        _tag: "harness-error",
        reason: "two tests",
        observations: [],
      });
    });
  });

  it.effect(
    "[probe-runner.rpc-unavailable] is unavailable, with keel-verify's reason, when it could not run the probe",
    () => {
      const v = verifier(() =>
        Exit.fail(new VerifierUnavailable({ reason: "lockfile-diverged: no deps bundle" })),
      );
      return Effect.gen(function* () {
        const error = yield* Effect.flip(run(v.entrypoint));
        expect(error).toMatchObject({
          _tag: "ProbeRunnerUnavailable",
          reason: "lockfile-diverged: no deps bundle",
        });
      });
    },
  );

  it.effect("[probe-runner.rpc-unavailable] is unavailable when keel-verify never answered", () => {
    const v = verifier(() => "throw");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(run(v.entrypoint));
      expect(error.reason).toBe("keel-verify did not answer: Network connection lost.");
    });
  });

  it.effect(
    "[probe-runner.rpc-ready] asks keel-verify, in a request it decodes, and answers the world ready",
    () => {
      const v = verifier(
        () => "throw",
        () => Exit.succeed({ _tag: "Ready" }),
      );
      return Effect.gen(function* () {
        expect(yield* ready(v.entrypoint)).toEqual({ _tag: "Ready" });
        expect(Schema.decodeUnknownSync(VerifierWorldReadyRequest)(v.asked[0])).toEqual({
          namespace: REQUEST.namespace,
          worldBundle: REQUEST.worldBundle,
        });
        expect(v.received).toEqual([]);
      });
    },
  );

  it.effect(
    "[probe-runner.rpc-unready] answers a world keel-verify could run no probe against as unready, with its reason",
    () => {
      const v = verifier(
        () => "throw",
        () => Exit.succeed({ _tag: "Unready", reason: "lockfile-diverged: no deps bundle" }),
      );
      return Effect.gen(function* () {
        expect(yield* ready(v.entrypoint)).toEqual({
          _tag: "Unready",
          reason: "lockfile-diverged: no deps bundle",
        });
      });
    },
  );

  it.effect(
    "[probe-runner.rpc-ready-unavailable] is unavailable, never unready, when keel-verify did not answer the question or did not decode it",
    () => {
      const silent = verifier(() => "throw");
      const undecoded = verifier(
        () => "throw",
        () => Exit.fail(new VerifierUnavailable({ reason: "the request did not decode" })),
      );
      return Effect.gen(function* () {
        expect(yield* Effect.flip(ready(silent.entrypoint))).toMatchObject({
          _tag: "ProbeRunnerUnavailable",
          reason: "keel-verify did not answer: Network connection lost.",
        });
        expect(yield* Effect.flip(ready(undecoded.entrypoint))).toMatchObject({
          _tag: "ProbeRunnerUnavailable",
          reason: "the request did not decode",
        });
      });
    },
  );

  it.effect(
    "[probe-runner.rpc-not-an-answer] anything that is not a run's answer, or a world's, is unavailable and never a defect, whatever it is",
    () =>
      Effect.gen(function* () {
        for (const raw of NOT_ANSWERS) {
          const unavailable = {
            _tag: "ProbeRunnerUnavailable",
            reason: "keel-verify's answer is not one",
          };
          expect(yield* Effect.flip(run(answering(raw)))).toMatchObject(unavailable);
          expect(yield* Effect.flip(ready(answering(raw)))).toMatchObject(unavailable);
        }
      }),
  );

  it("[probe-runner.entrypoint] reaches runProbe and worldReady on the VERIFIER binding, and refuses a binding without either", async () => {
    const calls: unknown[] = [];
    const binding = {
      fetch: async () => new Response(null),
      connect: () => {
        throw new Error("no sockets");
      },
      runProbe: async (r: unknown) => {
        calls.push(r);
        return "answered";
      },
      worldReady: async (r: unknown) => {
        calls.push(r);
        return "ready";
      },
      buildDeps: async (r: unknown) => {
        calls.push(r);
        return "built";
      },
    };
    expect(await verifierEntrypoint(binding).runProbe("r")).toBe("answered");
    expect(await verifierEntrypoint(binding).worldReady("w")).toBe("ready");
    expect(await verifierEntrypoint(binding).buildDeps("d")).toBe("built");
    expect(calls).toEqual(["r", "w", "d"]);
    expect(() => verifierEntrypoint({ fetch: binding.fetch, connect: binding.connect })).toThrow(
      /serves no runProbe/,
    );
    const probesOnly = {
      fetch: binding.fetch,
      connect: binding.connect,
      runProbe: binding.runProbe,
    };
    expect(() => verifierEntrypoint(probesOnly)).toThrow(/serves no worldReady/);
  });
});
