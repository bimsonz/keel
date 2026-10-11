import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: { bindings: { AUTH_SECRET: "spike-secret-0123456789abcdef0123456789abcdef" } },
    }),
  ],
  test: { testTimeout: 60_000 },
});
