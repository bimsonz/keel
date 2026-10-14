// Control for R13's scan of the examples: the example's test adds a binding its production lacks.
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default {
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { SWARM_EXTRA: "x" } } })],
};
