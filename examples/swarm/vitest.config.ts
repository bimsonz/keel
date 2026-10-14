import { execFileSync } from "node:child_process";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// The swarm's Worker as it deploys: Flue's build writes the config it deploys
// from, so the Worker is built before its config is read.
execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "error"], {
  cwd: import.meta.dirname,
  stdio: "inherit",
});

/**
 * Keel, as the test's stand-in on the outbound path: the sign-up's discovery,
 * the sign-up, the token exchange and an empty invitation list, recording
 * every request it is sent so a test can read what left the Worker.
 */
const STAND_IN = [
  `const seen = [];`,
  `const json = (body, status = 200) => Response.json(body, { status });`,
  `export default {`,
  `  async fetch(request) {`,
  `    const url = new URL(request.url);`,
  `    if (url.pathname === "/_seen") return json(seen);`,
  `    const body = await request.text();`,
  `    seen.push({ method: request.method, url: request.url, headers: [...request.headers], body });`,
  `    const origin = url.origin;`,
  `    if (url.pathname === "/.well-known/oauth-authorization-server")`,
  `      return json({ issuer: origin, token_endpoint: origin + "/token", registration_endpoint: origin + "/register" });`,
  `    if (url.pathname === "/register") return json({ client_id: "agt_STANDIN", handle: "agent-standin" }, 201);`,
  `    if (url.pathname === "/token") return json({ access_token: "token-" + seen.length, token_type: "Bearer", expires_in: 300 });`,
  `    return json({ items: [] });`,
  `  },`,
  `};`,
].join("\n");

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./dist/keel_swarm/wrangler.json" },
      remoteBindings: false,
      miniflare: {
        bindings: { KEEL_HOST: "keel.test", SWARM_ADMIN_TOKEN: "test-admin-token" },
        outboundService: "keel-stand-in",
        workers: [
          {
            name: "keel-stand-in",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: STAND_IN,
          },
        ],
      },
    }),
  ],
  test: {
    name: "pool:swarm",
    include: ["test/pool/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
