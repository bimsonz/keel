import { ProbeRunner, ProbeRunnerUnavailable } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  decodeExit,
  ProbeRunRequest,
  VerifierCodecs,
  type VerifierEntrypoint,
  WorldReadyRequest,
} from "../../../rpc/index.ts";

const encodeRequest = Schema.encodeSync(ProbeRunRequest);
const encodeReadyRequest = Schema.encodeSync(WorldReadyRequest);

/**
 * keel-verify's entrypoint behind the VERIFIER service binding, which
 * wrangler types as a plain Fetcher though RPC reaches its methods. A binding
 * that does not serve every method keel calls stops the composition.
 */
export const verifierEntrypoint = (binding: Fetcher): VerifierEntrypoint => {
  const method = (name: keyof VerifierEntrypoint) => {
    const served: unknown = Reflect.get(binding, name);
    if (typeof served !== "function") throw new Error(`VERIFIER serves no ${name}`);
    return async (request: unknown) => {
      const answer: unknown = await Reflect.apply(served, binding, [request]);
      return answer;
    };
  };
  return {
    runProbe: method("runProbe"),
    worldReady: method("worldReady"),
    buildDeps: method("buildDeps"),
  };
};

const didNotAnswer = (error: unknown) =>
  new ProbeRunnerUnavailable({
    reason: `keel-verify did not answer: ${error instanceof Error ? error.message : String(error)}`,
  });

/**
 * ProbeRunner over keel-verify's entrypoint (the VERIFIER service binding),
 * which routes each run to the VerifierDO for its (namespace, probe, world): a fresh
 * isolate with no network. keel-verify's VerifierUnavailable (a bundle
 * missing or forged, a world with no deps bundle) and a call that never
 * reached it are both ProbeRunnerUnavailable, for the caller to retry or
 * report; a harness error comes back as the run it is, never a cell.
 *
 * `ready` is keel-verify's `worldReady`, answered from its bundle store with
 * no VerifierDO and no isolate: its answer is the world's readiness, and
 * anything else (a call that never reached it, a request it did not decode)
 * is ProbeRunnerUnavailable, which says nothing of the world.
 */
export const ProbeRunnerRpc = (verifier: VerifierEntrypoint) =>
  Layer.succeed(
    ProbeRunner,
    ProbeRunner.of({
      run: (request) =>
        Effect.tryPromise({
          try: () => verifier.runProbe(encodeRequest(request)),
          catch: didNotAnswer,
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
      ready: (request) =>
        Effect.tryPromise({
          try: () => verifier.worldReady(encodeReadyRequest(request)),
          catch: didNotAnswer,
        }).pipe(
          Effect.flatMap((raw) => {
            const exit = decodeExit(VerifierCodecs.worldReady, raw);
            if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
            const failure = Cause.findErrorOption(exit.cause);
            return Option.isSome(failure)
              ? Effect.fail(new ProbeRunnerUnavailable({ reason: failure.value.reason }))
              : Effect.die(Cause.squash(exit.cause));
          }),
        ),
    }),
  );
