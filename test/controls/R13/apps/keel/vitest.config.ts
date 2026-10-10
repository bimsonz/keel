// Control for R13: the test adds a binding production does not have.
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default {
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { EXTRA_SECRET: "x", TEST_MIGRATIONS: [] } } })],
};
