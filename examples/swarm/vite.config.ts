import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

// flue() comes first: the Cloudflare plugin reads Flue's contributions (the
// Worker's entry and the agent's Durable Object binding) through flueWorkerConfig().
// The deploy builds from the config it rendered with the real host
// (scripts/deploy.ts sets KEEL_WRANGLER_CONFIG); anything else from the committed one.
export default defineConfig({
  plugins: [
    flue({ providers: ["cloudflare"] }),
    cloudflare({
      configPath: process.env["KEEL_WRANGLER_CONFIG"] ?? "wrangler.jsonc",
      config: flueWorkerConfig(),
    }),
  ],
});
