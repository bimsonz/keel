import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      // The Worker's own config, and nothing added to it: it is bound to its files and holds no secret.
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
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
