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
  },
});
