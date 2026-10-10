import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

/**
 * Live tests: driven adapters against the real services on staging, through
 * remote bindings (the Artifacts namespaces). Run locally with wrangler's
 * OAuth login and CLOUDFLARE_ACCOUNT_ID set; never in CI.
 *
 *   pnpm --filter keel exec vitest run -c vitest.live.config.ts
 */
export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: true,
      miniflare: {
        bindings: { KEEL_ENV: "live-test" },
        // keel-verify is another deployable; SANDBOX's class must exist for workerd to start.
        workers: [
          {
            name: "keel-verify",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: [
              `import { DurableObject } from "cloudflare:workers";`,
              `export class KeelSandbox extends DurableObject {}`,
              `export default { fetch() { return Response.json({ fake: "keel-verify" }); } };`,
            ].join("\n"),
            durableObjects: { SANDBOX: { className: "KeelSandbox", useSQLite: true } },
          },
        ],
      },
    }),
  ],
  test: {
    name: "live:keel",
    include: ["test/live/**/*.test.ts"],
    // Every call crosses the Atlantic from a laptop, and forks take seconds (S2).
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
