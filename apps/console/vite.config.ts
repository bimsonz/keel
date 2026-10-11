import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page's build. The Worker is bundled by wrangler, and the tests are run by the root's vitest projects.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5311, strictPort: true, host: true },
  preview: { port: 5311, strictPort: true, host: true },
  worker: { format: "es" },
});
