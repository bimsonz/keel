import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { type Env, createConsole } from "../../../src/worker/handler.ts";

const ORIGIN = "https://keel-console.example";

/** The Worker with its own files and Keel behind it, and a watch on what it asks of each. */
function rig() {
  const assets: string[] = [];
  const keel: Request[] = [];
  const answer = new Response("keel's answer", { status: 418 });
  const env: Env = {
    ASSETS: {
      fetch: (request) => {
        assets.push(`${request.method} ${new URL(request.url).pathname}`);
        return Promise.resolve(new Response("the page"));
      },
    },
    KEEL: {
      fetch: (request) => {
        keel.push(request);
        return Promise.resolve(answer);
      },
    },
  };
  const mission = createConsole();
  return {
    assets,
    keel,
    answer,
    fetch: (request: Request): Promise<Response> => mission.fetch(request, env),
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

/**
 * The paths the Worker's config runs it first for, as the platform reads them:
 * each a glob whose `*` matches any run of characters, a `/` among them.
 */
function runFirst(): RegExp[] {
  const errors: ParseError[] = [];
  const config: unknown = parse(
    readFileSync(join(import.meta.dirname, "../../../wrangler.jsonc"), "utf8"),
    errors,
    { allowTrailingComma: true },
  );
  expect(errors).toEqual([]);
  const assets: unknown =
    typeof config === "object" && config !== null && "assets" in config ? config.assets : undefined;
  const first: unknown =
    typeof assets === "object" && assets !== null && "run_worker_first" in assets
      ? assets.run_worker_first
      : undefined;
  if (!Array.isArray(first)) throw new Error("run_worker_first is not a list of paths");
  return first.map(
    (glob) =>
      new RegExp(
        `^${String(glob)
          .split("*")
          .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`))
          .join(".*")}$`,
      ),
  );
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
    expect(r.keel).toEqual([]);
    expect(r.assets).toEqual([
      "GET /api/v1/events",
      "GET /api/v1/projects/prj_1/repo/tree",
      "POST /present/capability",
      "POST /rule/a-capability",
    ]);
  });

  it("[handler.git-forward] hands a clone address's three git paths to Keel as they came, and answers what Keel answers", async () => {
    const r = rig();
    const sent = [
      new Request(`${ORIGIN}/acme/forge.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: "Basic Z2l0OnRva2Vu", "git-protocol": "version=2" },
      }),
      new Request(`${ORIGIN}/acme/forge.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": "application/x-git-upload-pack-request" },
        body: "0000",
      }),
      new Request(`${ORIGIN}/acme/forge.git/git-receive-pack`, { method: "POST", body: "0000" }),
    ];
    const asked = await watchingFetch(async () => {
      for (const request of sent) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, in the order asserted below
        expect(await r.fetch(request)).toBe(r.answer);
      }
    });
    // The very requests, so nothing of one was read, dropped or added on the way.
    expect(r.keel).toHaveLength(3);
    for (const [at, request] of sent.entries()) expect(r.keel[at]).toBe(request);
    expect(asked).toEqual([]);
    expect(r.assets).toEqual([]);
  });

  it.each([
    "/acme/forge.git",
    "/acme/forge.git/",
    "/acme/forge.git/../x",
    "/acme/forge.git/info/refs/x",
    "/acme/forge.git/info",
    "/acme/forge.git/HEAD",
    "/acme/forge.git/objects/info/packs",
    "/a/acme/forge.git/info/refs",
    "/forge.git/info/refs",
    "/acme/.git/info/refs",
    "/acme/forge/info/refs",
    "/acme/forge.gitx/info/refs",
    "/acme/forge.git/blob/trunk/info/refs",
  ])("[handler.git-forward] %s is no clone address: it is the page", async (path) => {
    const r = rig();
    const answer = await r.ask(`${path}?service=git-upload-pack`, {
      headers: { authorization: "Basic Z2l0OnRva2Vu" },
    });
    expect(await answer.text()).toBe("the page");
    expect(r.keel).toEqual([]);
  });

  it("[handler.keel-paths] hands Keel's own paths to Keel as they came, and answers what Keel answers", async () => {
    const r = rig();
    const sent = [
      new Request(`${ORIGIN}/v1/whoami`, { headers: { authorization: "Bearer a-token" } }),
      new Request(`${ORIGIN}/v1/auth/sign-in/passkey?x=1`, {
        method: "POST",
        headers: { cookie: "__Secure-keel.session_token=s", origin: ORIGIN },
        body: "{}",
      }),
      new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }),
      new Request(`${ORIGIN}/mcp/server-card`),
      new Request(`${ORIGIN}/start`),
      new Request(`${ORIGIN}/llms.txt`),
      new Request(`${ORIGIN}/.well-known/keel/allowed-signers`),
    ];
    const asked = await watchingFetch(async () => {
      for (const request of sent) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, in the order asserted below
        expect(await r.fetch(request)).toBe(r.answer);
      }
    });
    // The very requests, so nothing of one was read, dropped or added on the way.
    expect(r.keel).toHaveLength(sent.length);
    for (const [at, request] of sent.entries()) expect(r.keel[at]).toBe(request);
    expect(asked).toEqual([]);
    expect(r.assets).toEqual([]);
  });

  it.each([
    "/v1",
    "/v12/whoami",
    "/a/v1/whoami",
    "/mcpx",
    "/mcp.json",
    "/starter",
    "/start/",
    "/start/here",
    "/llms.txtx",
    "/llms.txt/x",
    "/.well-known",
    "/a/.well-known/x",
  ])("[handler.keel-paths] %s is no path of Keel's: it is the page", async (path) => {
    const r = rig();
    const answer = await r.ask(path, { headers: { authorization: "Bearer a-token" } });
    expect(await answer.text()).toBe("the page");
    expect(r.keel).toEqual([]);
  });

  // Where nothing is run first, the assets answer a path that is no file with the page, and the
  // Worker's code never runs: seen on keel.town, where every clone address answered HTML.
  it("[console.git-first] the Worker's config runs it first for every path it hands to Keel, and for no place in the page", () => {
    const first = runFirst();
    const firstFor = (path: string) => first.some((glob) => glob.test(path));
    for (const path of [
      "/acme/forge.git/info/refs",
      "/acme/forge.git/git-upload-pack",
      "/acme/forge.git/git-receive-pack",
      "/a.b/c-d_e.git/info/refs",
    ])
      expect([path, firstFor(path)]).toEqual([path, true]);
    for (const path of [
      "/",
      "/acme",
      "/acme/forge",
      "/acme/forge.git",
      "/acme/forge/blob/trunk/src/index.ts",
      "/acme/forge.git/blob/trunk/README.md",
      "/assets/index.js",
    ])
      expect([path, firstFor(path)]).toEqual([path, false]);
  });

  // A site with no routes has only this Worker at its door: Keel's own paths must reach its code.
  it("[console.keel-first] the Worker's config runs it first for each of Keel's own paths, and for no handle that begins like one", () => {
    const first = runFirst();
    const firstFor = (path: string) => first.some((glob) => glob.test(path));
    for (const path of [
      "/v1/whoami",
      "/v1/auth/sign-in/passkey",
      "/mcp",
      "/mcp/server-card",
      "/start",
      "/llms.txt",
      "/.well-known/keel/allowed-signers",
      "/.well-known/oauth-authorization-server",
    ])
      expect([path, firstFor(path)]).toEqual([path, true]);
    for (const path of ["/v1", "/v12/whoami", "/mcpx", "/starter", "/llms.txtx", "/.well-known"])
      expect([path, firstFor(path)]).toEqual([path, false]);
  });
});
