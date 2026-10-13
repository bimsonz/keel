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
} from "../../../keel-verify/src/rpc/index.ts";
import {
  ProbeRunnerRpc,
  verifierEntrypoint,
} from "../../src/adapters/driven/do-rpc/probe-runner.ts";

const hash = (n: number) => ContentHash.make(`sha256:${String(n).padStart(64, "0")}`);
const REQUEST: ProbeRunRequest = {
  namespace: sampleNamespace,
  probe: hash(1),
  world: "A-noop",
  worldBundle: hash(2),
  run: 3,
};

/** keel-verify's entrypoint, answering with keel-verify's own codec: the other copy of the contract. */
function verifier(answer: () => Exit.Exit<ProbeRunReply, VerifierUnavailable> | "throw") {
  const received: unknown[] = [];
  return {
    received,
    entrypoint: {
      runProbe: async (request: unknown) => {
        received.push(request);
        const exit = answer();
        if (exit === "throw") throw new Error("Network connection lost.");
        return encodeVerifierExit(KeelVerifyCodecs.runProbe, exit);
      },
    },
  };
}

const run = (entrypoint: { runProbe(request: unknown): Promise<unknown> }) =>
  Effect.gen(function* () {
    return yield* (yield* ProbeRunner).run(REQUEST);
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

  it("[probe-runner.entrypoint] reaches runProbe on the VERIFIER binding, and refuses a binding without it", async () => {
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
    };
    expect(await verifierEntrypoint(binding).runProbe("r")).toBe("answered");
    expect(calls).toEqual(["r"]);
    expect(() => verifierEntrypoint({ fetch: binding.fetch, connect: binding.connect })).toThrow(
      /serves no runProbe/,
    );
  });
});
