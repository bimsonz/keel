import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The console's Worker as it is deployed: its own wrangler config, and the
// built page as its assets. Nothing is added to the config for the test, so
// what the Worker is bound to here is what it is bound to in production.

const CONSOLE = "https://keel-console.localhost";

describe("the console's Worker", () => {
  it("answers /healthz itself", async () => {
    const response = await SELF.fetch(`${CONSOLE}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "keel-console" });
  });

  it("serves the built page at the root", async () => {
    const response = await SELF.fetch(`${CONSOLE}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root"');
  });

  it.each([
    "/keel/forge-lite/mission-control",
    "/keel/keel/blob/trunk/src/index.ts",
    "/keel/keel/subjects/authz.permission-evaluation",
    "/keel",
    "/signup",
  ])("[console.spa] serves the page at %s", async (path) => {
    const response = await SELF.fetch(`${CONSOLE}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root"');
  });

  it("[console.no-credential] is bound to its own files and nothing else, and holds no secret", () => {
    // The test pool binds a few things of its own to run the tests through. They are not the Worker's.
    const own = Object.keys(env).filter((name) => !name.startsWith("__VITEST_POOL_WORKERS_"));
    expect(own.toSorted()).toEqual(["ASSETS", "KEEL_HOST"]);
  });

  it("[console.no-proxy] reads nothing of Keel for anyone: where its proxy was is the page, whatever key is shown", async () => {
    const response = await SELF.fetch(`${CONSOLE}/api/v1/events?limit=5`, {
      headers: { authorization: "Bearer test-presenter-key" },
    });
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root"');
  });
});
