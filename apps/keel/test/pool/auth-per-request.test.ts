import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { isolateLayer, makeIsolate } from "../../src/composition/isolate.ts";
import { BASE } from "./helpers.ts";

// The hang this guards against needs Workers to drop a finished request's pending
// work, which the pool doesn't do: there, the instance a first, non-auth request
// made answers later requests too. So the guard is on where the instance is made;
// the live proof is the hang's reproducer, run on a deployed Keel before and after.
it("[ba.per-request] makes Better Auth inside each /v1/auth request, never when the isolate is built", async () => {
  let made = 0;
  const isolate = makeIsolate(env, isolateLayer(env), { made: () => (made += 1) });
  const fetch = (path: string) =>
    isolate.app.fetch(new Request(`${BASE}${path}`), env, createExecutionContext());
  expect(made).toBe(0);
  expect((await fetch("/healthz")).status).toBe(200);
  expect(made).toBe(0);
  expect((await fetch("/v1/auth/ok")).status).toBe(200);
  expect((await fetch("/v1/auth/ok")).status).toBe(200);
  expect(made).toBe(2);
});
