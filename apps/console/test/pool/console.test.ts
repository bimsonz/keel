import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// The console's Worker as it is deployed: its own wrangler config, the built
// page as its assets, and Keel behind the config's own service binding. The
// `keel` it reaches is a stand-in (keel.worker.ts) that keeps what reached it.

const CONSOLE = "https://keel-console.localhost";

interface Seen {
  method: string;
  path: string;
  host: string;
  authorization: string | null;
}

/** What has reached Keel since the test began. */
async function reachedKeel(): Promise<Seen[]> {
  const response = await env.KEEL.fetch("https://keel.localhost/test/seen");
  return response.json();
}

beforeEach(async () => {
  await env.KEEL.fetch("https://keel.localhost/test/forget");
});

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
    "/forge-lite/mission-control",
    "/keel/blob/trunk/src/index.ts",
    "/keel/subjects/authz.permission-evaluation",
  ])("serves the page at %s, and asks Keel nothing to do it", async (path) => {
    const response = await SELF.fetch(`${CONSOLE}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root"');
    expect(await reachedKeel()).toEqual([]);
  });

  it("[console.anonymous] sends a visitor's read to Keel with no Authorization and no token asked for, and answers as Keel did", async () => {
    const response = await SELF.fetch(`${CONSOLE}/api/v1/events?limit=5`);
    expect(await reachedKeel()).toEqual([
      { method: "GET", path: "/v1/events?limit=5", host: "keel.localhost", authorization: null },
    ]);
    expect(response.status).toBe(401);
  });

  it("[console.presenter] reads as the observer for the presenter", async () => {
    const response = await SELF.fetch(`${CONSOLE}/api/v1/events?limit=5`, {
      headers: { authorization: "Bearer test-presenter-key" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: "0" });
    // The observer's token, and not the key that earned it. A token is exchanged at most once before it.
    const reached = await reachedKeel();
    expect(reached.at(-1)).toEqual({
      method: "GET",
      path: "/v1/events?limit=5",
      host: "keel.localhost",
      authorization: "Bearer tok_observer",
    });
    expect(reached.slice(0, -1).map((call) => call.path)).toEqual(
      reached.length === 1 ? [] : ["/v1/oauth/token"],
    );
  });

  it("[console.wrong-key] refuses a key that is not the presenter's without asking Keel anything", async () => {
    const response = await SELF.fetch(`${CONSOLE}/api/v1/events`, {
      headers: { authorization: "Bearer not-the-key" },
    });
    expect(response.status).toBe(401);
    expect(await reachedKeel()).toEqual([]);
  });
});
