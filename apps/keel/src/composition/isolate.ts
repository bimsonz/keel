import { whoami } from "@keeltown/core/application/identity";
import { TokenIssuer } from "@keeltown/core/ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { AgentDirectoryD1 } from "../adapters/driven/d1/agent-directory.ts";
import { TokenIssuerJose } from "../adapters/driven/jose/token-issuer.ts";
import { ClockLive, SystemLive } from "../adapters/driven/system.ts";
import { makeApp } from "../adapters/driving/http/app.ts";
import type { TokenVerifier, Verification } from "../adapters/driving/http/caller.ts";
import { makeHandlers } from "../adapters/driving/http/handlers.ts";
import { makeRunner, type IsolateServices } from "../adapters/driving/http/run.ts";
import { makeMcpEndpoint } from "../adapters/driving/mcp/server.ts";

/**
 * The isolate's composition root: the one place `env` becomes objects. One
 * ManagedRuntime per Env, built only from binding-backed adapters; nothing
 * request-scoped is cached in it.
 */
export function isolateLayer(env: Env): Layer.Layer<IsolateServices> {
  return Layer.mergeAll(
    AgentDirectoryD1(env.DB),
    TokenIssuerJose({ privateJwk: env.KEEL_SIGNING_KEY, issuer: env.KEEL_HOST }).pipe(
      Layer.provide(ClockLive),
    ),
    SystemLive,
  );
}

export type IsolateRuntime = ManagedRuntime.ManagedRuntime<IsolateServices, never>;

/** A bearer token is good if it verifies and its agent may still act at the token's epoch. */
function makeVerifier(runtime: IsolateRuntime): TokenVerifier {
  return (token) =>
    runtime.runPromise(
      TokenIssuer.use((issuer) => issuer.verify(token)).pipe(
        Effect.flatMap((principal) =>
          whoami(principal).pipe(
            Effect.as<Verification>({ principal }),
            Effect.catchTag("AgentNotAdmitted", () =>
              Effect.succeed<Verification>({ refused: "revoked" }),
            ),
          ),
        ),
        Effect.catch(() => Effect.succeed<Verification>({ refused: "invalid" })),
      ),
    );
}

interface Isolate {
  readonly runtime: IsolateRuntime;
  readonly app: ReturnType<typeof makeApp>;
}

const isolates = new WeakMap<Env, Isolate>();

export function isolateFor(env: Env): Isolate {
  let isolate = isolates.get(env);
  if (isolate === undefined) {
    const runtime = ManagedRuntime.make(isolateLayer(env));
    const handlers = makeHandlers(makeRunner(runtime));
    const verify = makeVerifier(runtime);
    const app = makeApp({
      handlers,
      verify,
      mcp: makeMcpEndpoint(handlers, verify, [env.KEEL_HOST]),
      rethrowContractDrift: env.KEEL_ENV === "test",
    });
    isolate = { runtime, app };
    isolates.set(env, isolate);
  }
  return isolate;
}
