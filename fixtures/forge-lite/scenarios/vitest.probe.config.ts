import { defineConfig } from "vitest/config";

// Runs only the revocation probe. Paths are relative to the fixture root,
// which is where scenarios/run-probe.mjs starts vitest.
export default defineConfig({
  test: {
    include: ["scenarios/s1/probe.test.ts"],
  },
});
