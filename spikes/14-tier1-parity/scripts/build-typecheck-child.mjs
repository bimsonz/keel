// Bundles child-src/typecheck-entry.js into one ES module for a Worker Loader child.
// The installer import inside worker-bundler/typescript is wrapped so a host can
// hand the child TypeScript's lib .d.ts files instead of a registry tarball fetch.
import { build } from "esbuild";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const out = process.argv[2] ?? "dist-child";
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const tsEntry = join(process.cwd(), "node_modules/@cloudflare/worker-bundler/dist/typescript.js");

const wrapInstaller = {
  name: "wrap-installer",
  setup(b) {
    b.onResolve({ filter: /installer-[^/]+\.js$/ }, (args) => {
      if (args.namespace === "wrapped") return undefined;
      return { path: join(args.resolveDir, args.path), namespace: "wrapped" };
    });
    b.onLoad({ filter: /.*/, namespace: "wrapped" }, (args) => ({
      resolveDir: dirname(args.path),
      contents: `
        import { t as original } from ${JSON.stringify(args.path + "?real")};
        export function t(name, meta) {
          if (globalThis.__KEEL_TS_LIBS) return Promise.resolve(globalThis.__KEEL_TS_LIBS);
          return original(name, meta);
        }`,
    }));
    b.onResolve({ filter: /\?real$/ }, (args) => ({ path: args.path.replace(/\?real$/, "") }));
  },
};

const r = await build({
  entryPoints: ["child-src/typecheck-entry.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: join(out, "typecheck-child.js"),
  plugins: [wrapInstaller],
  alias: { "@cloudflare/worker-bundler/typescript": tsEntry },
  metafile: true,
  logLevel: "warning",
});
const bytes = Object.values(r.metafile.outputs).reduce((a, o) => a + o.bytes, 0);

// lib.*.d.ts from the local TypeScript install, keyed as worker-bundler expects ("lib/lib.x.d.ts").
const libDir = join(dirname(require.resolve("typescript/package.json")), "lib");
const libs = {};
for (const f of readdirSync(libDir)) if (/^lib\..*\.d\.ts$/.test(f)) libs[`lib/${f}`] = readFileSync(join(libDir, f), "utf8");
writeFileSync(join(out, "ts-libs.json"), JSON.stringify(libs));
console.log(JSON.stringify({ childBytes: bytes, libFiles: Object.keys(libs).length, libBytes: JSON.stringify(libs).length, tsVersion: require("typescript/package.json").version }));
