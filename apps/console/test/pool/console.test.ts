import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The console's Worker as it is deployed: its own wrangler config, and the
// built page as its assets. Nothing is added to the config for the test but a
// stand-in for Keel's Worker, so what the Worker is bound to here is what it
// is bound to in production.

const CONSOLE = "https://keel-console.localhost";

/** A card's tag's content, by the attribute and value it is found by, in served HTML. */
const card = (html: string, attribute: string, value: string): string | undefined =>
  new RegExp(`<meta ${attribute}="${value}" content="([^"]*)"`).exec(html)?.[1];

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

  it("[console.api-catalog] says at its root where Keel's catalogue of its API is, and on no other page", async () => {
    // RFC 9727: whoever is given only the address finds the catalogue from the root's own headers.
    const root = await SELF.fetch(`${CONSOLE}/`);
    expect(root.headers.get("link")).toBe('</.well-known/api-catalog>; rel="api-catalog"');
    const elsewhere = await SELF.fetch(`${CONSOLE}/signup`);
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get("link")).toBeNull();
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

  it("[console.cards] gives a crawler a project's card in the page's own tags, and anyone else the site's", async () => {
    const tagged = async (path: string, agent: string): Promise<string> =>
      (await SELF.fetch(`${CONSOLE}${path}`, { headers: { "user-agent": agent } })).text();

    const shared = await tagged("/keel/keel/changes", "Twitterbot/1.0");
    expect(card(shared, "property", "og:title")).toBe("keel/keel");
    expect(card(shared, "name", "twitter:title")).toBe("keel/keel");
    expect(card(shared, "property", "og:url")).toBe(`${CONSOLE}/keel/keel/changes`);
    expect(card(shared, "property", "og:image")).toBe(`${CONSOLE}/og.png`);
    expect(card(shared, "name", "twitter:card")).toBe("summary_large_image");
    expect(shared).toContain("<title>keel/keel</title>");
    expect(shared).toContain('<div id="root"');

    // A person, the root, and a project Keel shows nobody all have the site's card, as the page was built.
    for (const [path, agent] of [
      ["/keel/keel", "Mozilla/5.0 (Macintosh) Chrome/141.0"],
      ["/", "Twitterbot/1.0"],
      ["/acme/secret", "Twitterbot/1.0"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      const html = await tagged(path, agent);
      expect([path, card(html, "property", "og:title")]).toEqual([path, "Keel"]);
      expect([path, card(html, "property", "og:image")]).toEqual([
        path,
        "https://keel.town/og.png",
      ]);
    }
    const image = await SELF.fetch(`${CONSOLE}/og.png`);
    expect([image.status, image.headers.get("content-type")]).toEqual([200, "image/png"]);
  });

  it("[console.no-credential] is bound to its own files and to Keel's Worker, and holds no secret", () => {
    // The test pool binds a few things of its own to run the tests through. They are not the Worker's.
    const own = Object.keys(env).filter((name) => !name.startsWith("__VITEST_POOL_WORKERS_"));
    expect(own.toSorted()).toEqual(["ASSETS", "KEEL", "KEEL_HOST"]);
  });

  it("[console.git-forward] a clone address's git paths reach Keel as they came, past the page", async () => {
    const advertised = await SELF.fetch(
      `${CONSOLE}/acme/forge.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: "Basic Z2l0OnRva2Vu" } },
    );
    expect(await advertised.json()).toEqual({
      keel: "GET /acme/forge.git/info/refs?service=git-upload-pack",
      authorization: "Basic Z2l0OnRva2Vu",
      body: "",
    });
    const negotiated = await SELF.fetch(`${CONSOLE}/acme/forge.git/git-upload-pack`, {
      method: "POST",
      body: "0009done\n",
    });
    expect(await negotiated.json()).toEqual({
      keel: "POST /acme/forge.git/git-upload-pack",
      authorization: null,
      body: "0009done\n",
    });
    const pushed = await SELF.fetch(`${CONSOLE}/acme/forge.git/git-receive-pack`, {
      method: "POST",
      body: "0000",
    });
    expect(await pushed.json()).toMatchObject({ keel: "POST /acme/forge.git/git-receive-pack" });
  });

  it.each([
    "/acme/forge.git",
    "/acme/forge.git/info/refs/x",
    "/a/acme/forge.git/info/refs",
    "/acme/forge.git/blob/trunk/info/refs",
  ])("[console.git-forward] %s is no clone address: it is the page", async (path) => {
    const response = await SELF.fetch(`${CONSOLE}${path}?service=git-upload-pack`);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root"');
  });

  it.each([
    ["GET", "/v1/whoami"],
    ["POST", "/v1/auth/sign-in/passkey"],
    ["POST", "/mcp"],
    ["GET", "/mcp/server-card"],
    ["GET", "/start"],
    ["GET", "/llms.txt"],
    ["GET", "/.well-known/keel/allowed-signers"],
  ])("[console.keel-paths] %s %s reaches Keel as it came, past the page", async (method, path) => {
    const body = method === "POST" ? "{}" : undefined;
    const response = await SELF.fetch(`${CONSOLE}${path}?x=1`, {
      method,
      headers: { authorization: "Bearer a-token" },
      ...(body === undefined ? {} : { body }),
    });
    expect(await response.json()).toEqual({
      keel: `${method} ${path}?x=1`,
      authorization: "Bearer a-token",
      body: body ?? "",
    });
  });

  it.each(["/v1", "/mcpx", "/starter", "/llms.txtx", "/.well-known"])(
    "[console.keel-paths] %s is no path of Keel's: it is the page",
    async (path) => {
      const response = await SELF.fetch(`${CONSOLE}${path}`);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain('<div id="root"');
    },
  );

  it.each(["/admin", "/admin/users", "/install", "/logout", "/favicon.ico", "/sitemap.xml"])(
    "[console.not-found] nothing here answers %s: 404, with the page, which draws its own not-found",
    async (path) => {
      const response = await SELF.fetch(`${CONSOLE}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("link")).toBeNull();
      expect(await response.text()).toContain('<div id="root"');
    },
  );

  it("[console.robots] tells crawlers they may read every page, and that Keel's API is not for indexing", async () => {
    const response = await SELF.fetch(`${CONSOLE}/robots.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const rules = (await response.text())
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(rules).toEqual(["User-agent: *", "Allow: /", "Disallow: /v1/"]);
  });

  it("[console.openapi] sends /openapi.json on to Keel's API description, for good", async () => {
    const response = await SELF.fetch(`${CONSOLE}/openapi.json`, { redirect: "manual" });
    expect(response.status).toBe(301);
    expect(new URL(response.headers.get("location") ?? "", CONSOLE).pathname).toBe(
      "/v1/openapi.json",
    );
  });

  it("[console.no-proxy] reads nothing of Keel for anyone: where its proxy was is the page, whatever key is shown", async () => {
    const response = await SELF.fetch(`${CONSOLE}/api/v1/events?limit=5`, {
      headers: { authorization: "Bearer test-presenter-key" },
    });
    // A reserved segment nothing here answers: the page, as not found.
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('<div id="root"');
  });
});
