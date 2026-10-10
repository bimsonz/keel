import { defineConfig } from "vitest/config";

// Projects:
//   unit   Node: domain, application, tooling and other pure code
//   arch   Node: architecture rules and guards (packages/tooling)
//   pool:* workerd, one project per Worker (each app's vitest.config.ts)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "examples/*/test/**/*.test.ts",
          ],
          exclude: ["packages/tooling/test/arch/**", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "arch",
          environment: "node",
          // ArchUnitTS registers its matchers on import and needs vitest's globals to do it.
          globals: true,
          include: ["packages/tooling/test/arch/**/*.test.ts"],
        },
      },
      "apps/*/vitest.config.ts",
    ],
  },
});
