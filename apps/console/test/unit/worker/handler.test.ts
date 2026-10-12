import { describe, expect, it } from "vitest";
import { type Env, createConsole } from "../../../src/worker/handler.ts";

const ORIGIN = "https://keel-console.example";

/** The Worker with its own files behind it, and a watch on anything it asks of anywhere else. */
function rig() {
  const assets: string[] = [];
  const env: Env = {
    ASSETS: {
      fetch: (request) => {
        assets.push(`${request.method} ${new URL(request.url).pathname}`);
        return Promise.resolve(new Response("the page"));
      },
    },
  };
  const mission = createConsole();
  return {
    assets,
    ask: (path: string, init?: RequestInit): Promise<Response> =>
      mission.fetch(new Request(`${ORIGIN}${path}`, init), env),
  };
}

/** Runs `what` with the runtime's own fetch watched: every address asked for through it. */
async function watchingFetch(what: () => Promise<void>): Promise<string[]> {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input) => {
    asked.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response(null, { status: 502 }));
  };
  try {
    await what();
  } finally {
    globalThis.fetch = real;
  }
  return asked;
}

describe("the console's Worker", () => {
  it("answers its health check and hands every other path to the page", async () => {
    const r = rig();
    expect(await (await r.ask("/healthz")).json()).toEqual({ ok: true, service: "keel-console" });
    await r.ask("/");
    await r.ask("/assets/index.js");
    await r.ask("/keel/forge-lite/blob/trunk/src/index.ts");
    expect(r.assets).toEqual([
      "GET /",
      "GET /assets/index.js",
      "GET /keel/forge-lite/blob/trunk/src/index.ts",
    ]);
  });

  it("[handler.no-proxy] has no way to Keel: the paths it once read and ruled through are the page's, like any other", async () => {
    const r = rig();
    const sent = { authorization: "Bearer anything", cookie: "__Secure-keel.session_token=s" };
    const asked = await watchingFetch(async () => {
      for (const [method, path] of [
        ["GET", "/api/v1/events?limit=5"],
        ["GET", "/api/v1/projects/prj_1/repo/tree?path="],
        ["POST", "/present/capability"],
        ["POST", "/rule/a-capability"],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, in the order asserted below
        const answer = await r.ask(path, { method, headers: sent });
        expect(await answer.text()).toBe("the page");
      }
    });
    expect(asked).toEqual([]);
    expect(r.assets).toEqual([
      "GET /api/v1/events",
      "GET /api/v1/projects/prj_1/repo/tree",
      "POST /present/capability",
      "POST /rule/a-capability",
    ]);
  });
});
