// Bundles each child (src/children/*.ts) into one ESM file whose wasm/data imports
// stay external as "./<name>.wasm" / "./<name>.bin".
//  - build/children/<child>.txt  the host imports these as text and passes them as {js}
//  - build/wasm/child-<child>.js the static tools Worker imports these; wrangler then
//    resolves ./<name>.wasm next to them as CompiledWasm modules.
// One bundle, two deployments: the dynamic and static paths run identical JS.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = ["ruff", "clang", "hcl", "treesitter", "pad", "memgrow", "fetchprobe", "compileprobe"];
mkdirSync(join(root, "build", "children"), { recursive: true });
mkdirSync(join(root, "build", "wasm"), { recursive: true });
copyFileSync(join(root, "build", "wasm", "tiny.wasm"), join(root, "build", "wasm", "tiny.bin"));

const externalBinaries: Plugin = {
  name: "external-binaries",
  setup(b) {
    b.onResolve({ filter: /\.(wasm|bin)$/ }, (args) => ({ path: `./${basename(args.path)}`, external: true }));
  },
};

// Workers (compat date >= the one used here) expose a `process` global with
// versions.node even without nodejs_compat, so Emscripten's environment sniffing in
// web-tree-sitter picks its Node branch (await import("module"), fs reads). Pin it off.
const NODE_SNIFF = 'var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";';
const notNode: Plugin = {
  name: "web-tree-sitter-not-node",
  setup(b) {
    b.onLoad({ filter: /web-tree-sitter[\\/]web-tree-sitter\.js$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      if (!src.includes(NODE_SNIFF)) throw new Error("web-tree-sitter: environment sniff not found; re-check the patch");
      return { contents: src.replace(NODE_SNIFF, "var ENVIRONMENT_IS_NODE = false;"), loader: "js" };
    });
  },
};

const stub = join(root, "src", "children", "node-stub.ts");
for (const name of children) {
  const result = await build({
    entryPoints: [join(root, "src", "children", `${name}.ts`)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser", "import"],
    alias: { module: stub, "fs/promises": stub },
    plugins: [externalBinaries, notNode],
    logLevel: "warning",
  });
  const js = result.outputFiles[0].text;
  writeFileSync(join(root, "build", "children", `${name}.txt`), js);
  writeFileSync(join(root, "build", "wasm", `child-${name}.js`), js);
  const imports = [...js.matchAll(/from\s+"(\.\/[^"]+\.(?:wasm|bin))"/g)].map((m) => m[1]);
  console.log(`${name.padEnd(13)} ${String(js.length).padStart(8)} B js  imports ${imports.join(", ") || "-"}`);
}
// Fail loudly if a bundle still reaches for a node builtin.
for (const name of children) {
  const js = readFileSync(join(root, "build", "children", `${name}.txt`), "utf8");
  const bad = [...js.matchAll(/(?:from|import\()\s*"(node:[^"]+|fs|module|path|url|crypto)"/g)].map((m) => m[1]);
  if (bad.length) throw new Error(`${name}: unresolved builtin imports ${bad.join(", ")}`);
}
