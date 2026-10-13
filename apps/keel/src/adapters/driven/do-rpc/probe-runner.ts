import { ProbeRunner, ProbeRunnerUnavailable } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  decodeExit,
  ProbeRunRequest,
  VerifierCodecs,
  type VerifierEntrypoint,
} from "../../../rpc/index.ts";

const encodeRequest = Schema.encodeSync(ProbeRunRequest);

/**
 * keel-verify's entrypoint behind the VERIFIER service binding, which
 * wrangler types as a plain Fetcher though RPC reaches its methods. A binding
 * that serves no `runProbe` stops the composition.
 */
export const verifierEntrypoint = (binding: Fetcher): VerifierEntrypoint => {
  const runProbe: unknown = Reflect.get(binding, "runProbe");
  if (typeof runProbe !== "function") throw new Error("VERIFIER serves no runProbe");
  return {
    runProbe: async (request) => {
      const answer: unknown = await Reflect.apply(runProbe, binding, [request]);
      return answer;
    },
  };
};

/**
 * ProbeRunner over keel-verify's entrypoint (the VERIFIER service binding),
 * which routes each run to the VerifierDO for its (namespace, probe, world): a fresh
 * isolate with no network. keel-verify's VerifierUnavailable (a bundle
 * missing or forged, a world with no deps bundle) and a call that never
 * reached it are both ProbeRunnerUnavailable, for the caller to retry or
 * report; a harness error comes back as the run it is, never a cell.
 */
export const ProbeRunnerRpc = (verifier: VerifierEntrypoint) =>
  Layer.succeed(
    ProbeRunner,
    ProbeRunner.of({
      run: (request) =>
        Effect.tryPromise({
          try: () => verifier.runProbe(encodeRequest(request)),
          catch: (error) =>
            new ProbeRunnerUnavailable({
              reason: `keel-verify did not answer: ${error instanceof Error ? error.message : String(error)}`,
            }),
        }).pipe(
          Effect.flatMap((raw) => {
            const exit = decodeExit(VerifierCodecs.runProbe, raw);
            if (Exit.isSuccess(exit)) return Effect.succeed(exit.value.run);
            const failure = Cause.findErrorOption(exit.cause);
            return Option.isSome(failure)
              ? Effect.fail(new ProbeRunnerUnavailable({ reason: failure.value.reason }))
              : Effect.die(Cause.squash(exit.cause));
          }),
        ),
    }),
  );
