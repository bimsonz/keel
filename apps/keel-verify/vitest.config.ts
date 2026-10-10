import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
    }),
  ],
  test: {
    name: "pool:keel-verify",
    include: ["test/pool/**/*.test.ts"],
    // The first test in a pool pays workerd's cold module load (the sandbox SDK alone is ~3.5 s).
    testTimeout: 30_000,
  },
});
