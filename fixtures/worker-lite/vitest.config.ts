import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Logs from passing tests are noise; failing tests still show theirs.
    silent: "passed-only",
  },
});
