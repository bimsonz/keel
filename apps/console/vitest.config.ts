import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

/** The stand-in Keel, typechecked as TypeScript and served as plain JavaScript. */
const standInKeel = stripTypeScriptTypes(
  readFileSync(`${import.meta.dirname}/test/pool/keel.worker.ts`, "utf8"),
);

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          KEEL_OBSERVER_CLIENT_ID: "observer-id",
          KEEL_OBSERVER_CLIENT_SECRET: "observer-secret",
          KEEL_OPERATOR_CLIENT_ID: "operator-id",
          KEEL_OPERATOR_CLIENT_SECRET: "operator-secret",
          CONSOLE_CAPABILITY_KEY: "test-capability-key",
          CONSOLE_PRESENTER_KEY: "test-presenter-key",
        },
        // Keel is another deployable. The config's own service binding reaches this stand-in,
        // because it is the Worker named `keel` here.
        workers: [
          {
            name: "keel",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: standInKeel,
          },
        ],
      },
    }),
  ],
  test: {
    name: "pool:console",
    include: ["test/pool/**/*.test.ts"],
    // The page is built before the Worker that serves it is tested.
    globalSetup: ["test/pool/build.ts"],
    // The first test in a pool pays workerd's cold module load.
    testTimeout: 30_000,
  },
});
