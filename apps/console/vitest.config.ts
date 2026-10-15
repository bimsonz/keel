import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      // The Worker's own config: it is bound to its files and to Keel's Worker, and holds no secret.
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      // Keel is another deployable: the tests bind KEEL to a stand-in that says what reached it.
      miniflare: {
        workers: [
          {
            name: "keel",
            modules: true,
            compatibilityDate: "2026-10-01",
            script: [
              `export default {`,
              `  async fetch(request) {`,
              `    const { pathname, search } = new URL(request.url);`,
              // Anyone's read of a project: keel/* is public, and every other project is none.
              `    const project = /^\\/v1\\/namespaces\\/([^/]+)\\/projects\\/([^/]+)$/.exec(pathname);`,
              `    if (project !== null)`,
              `      return project[1] === "keel" && request.headers.get("cookie") === null`,
              `        ? Response.json({ id: "prj_1", namespace: { handle: "keel", kind: "org" }, name: project[2], visibility: "public" })`,
              `        : Response.json({ code: "resource.not_found" }, { status: 404 });`,
              `    return Response.json({`,
              `      keel: request.method + " " + pathname + search,`,
              `      authorization: request.headers.get("authorization"),`,
              `      body: await request.text(),`,
              `    });`,
              `  },`,
              `};`,
            ].join("\n"),
          },
        ],
      },
    }),
  ],
  test: {
    name: "pool:console",
    include: ["test/pool/**/*.test.ts"],
    // The page is built before the Worker that serves it is tested.
    globalSetup: ["test/pool/build.ts"],
    // The first test in a pool pays workerd's cold module load.
    testTimeout: 30_000,
  },
});
