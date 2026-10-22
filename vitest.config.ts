import { defineConfig } from "vitest/config";

// Projects:
//   unit   Node: domain, application, tooling and other pure code
//   arch   Node: architecture rules and guards (packages/tooling)
//   pool:* workerd, one project per Worker (each app's, and each example's, vitest.config.ts)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          // Tests that spawn git, and properties that play hundreds of runs, take a second alone and pass
          // vitest's 5 s default inside the whole suite on a loaded machine: the arch tests' limit, for all.
          testTimeout: 60_000,
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "examples/*/test/**/*.test.ts",
            "apps/*/test/unit/**/*.test.ts",
          ],
          // An example's pool tests run in workerd, in its own project.
          exclude: [
            "packages/tooling/test/arch/**",
            "examples/*/test/pool/**",
            "**/node_modules/**",
          ],
        },
      },
      {
        test: {
          name: "arch",
          environment: "node",
          // ArchUnitTS registers its matchers on import and needs vitest's globals to do it.
          globals: true,
          // Whole-tree scans and ArchUnitTS's TypeScript program take seconds on CI runners.
          testTimeout: 60_000,
          include: ["packages/tooling/test/arch/**/*.test.ts"],
        },
      },
      "apps/*/vitest.config.ts",
      "examples/*/vitest.config.ts",
    ],
  },
});
