import { whoami } from "@keeltown/core/application/identity";
import type { AgentId, ChangeId } from "@keeltown/core/kernel";
import { type Changes, type Inbox, TokenIssuer } from "@keeltown/core/ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { AgentDirectoryD1 } from "../adapters/driven/d1/agent-directory.ts";
import { ChangesRpc } from "../adapters/driven/do-rpc/changes.ts";
import { InboxRpc } from "../adapters/driven/do-rpc/inbox.ts";
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
export function isolateLayer(
  env: Env,
  overrides: IsolateOverrides = {},
): Layer.Layer<IsolateServices> {
  const agentSession = (agentId: AgentId) =>
    env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`));
  const change = (changeId: ChangeId) =>
    env.CHANGE.get(env.CHANGE.idFromName(`change:${changeId}`));
  return Layer.mergeAll(
    overrides.changes ?? ChangesRpc({ change, agentSession }),
    overrides.inbox ?? InboxRpc(agentSession),
    AgentDirectoryD1(env.DB),
    TokenIssuerJose({ privateJwk: env.KEEL_SIGNING_KEY, issuer: env.KEEL_HOST }).pipe(
      Layer.provide(ClockLive),
    ),
    SystemLive,
  );
}

/** Pool tests swap the work loop's DO-backed ports for in-memory ones; production passes none. */
export interface IsolateOverrides {
  readonly changes?: Layer.Layer<Changes>;
  readonly inbox?: Layer.Layer<Inbox>;
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

/** The app over a given layer. `isolateFor` caches the production one per Env; pool tests build their own. */
export function makeIsolate(env: Env, layer: Layer.Layer<IsolateServices>): Isolate {
  const runtime = ManagedRuntime.make(layer);
  const handlers = makeHandlers(makeRunner(runtime));
  const verify = makeVerifier(runtime);
  const app = makeApp({
    handlers,
    verify,
    mcp: makeMcpEndpoint(handlers, verify, [env.KEEL_HOST]),
    rethrowContractDrift: env.KEEL_ENV === "test",
  });
  return { runtime, app };
}

export function isolateFor(env: Env): Isolate {
  let isolate = isolates.get(env);
  if (isolate === undefined) {
    isolate = makeIsolate(env, isolateLayer(env));
    isolates.set(env, isolate);
  }
  return isolate;
}
