import { exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

/**
 * The Worker's cold load: its whole module graph, the CI engine and the
 * sandbox SDK among it, mostly vite transforms. Reached first through
 * `exports` inside the test, it ran under the test's own timeout and missed
 * it on a loaded machine; loaded here, it has a bound of its own.
 */
const LOAD_MS = 180_000;

/** What answering /healthz may take once the Worker is loaded. */
const HEALTH_MS = 10_000;

beforeAll(async () => {
  await import("../../src/index.ts");
}, LOAD_MS);

it(
  "answers /healthz through the Worker's own fetch handler",
  async () => {
    const response = await exports.default.fetch("https://keel-verify.localhost/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "keel-verify" });
  },
  HEALTH_MS,
);
