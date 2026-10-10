import { makeApp } from "../adapters/driving/http/app.ts";
import type { TokenVerifier } from "../adapters/driving/http/caller.ts";
import { makeHandlers } from "../adapters/driving/http/handlers.ts";
import { makeMcpEndpoint } from "../adapters/driving/mcp/server.ts";

/**
 * Until token issuance lands, no bearer token verifies: every
 * authenticated operation answers 401, and anonymous ones are served.
 */
const noTokensYet: TokenVerifier = async () => null;

/** The isolate's composition root: the one place `env` becomes objects. One app per Env. */
const apps = new WeakMap<Env, ReturnType<typeof makeApp>>();

export function appFor(env: Env) {
  let app = apps.get(env);
  if (app === undefined) {
    const handlers = makeHandlers();
    app = makeApp({
      handlers,
      verify: noTokensYet,
      mcp: makeMcpEndpoint(handlers, noTokensYet, [env.KEEL_HOST]),
      rethrowContractDrift: env.KEEL_ENV === "test",
    });
    apps.set(env, app);
  }
  return app;
}
