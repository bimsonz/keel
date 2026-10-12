/**
 * Writes `src/generated/`: web-tree-sitter's glue with two edits, its types,
 * and the parser's version string. The script fails if either line it edits
 * is ever not exactly as expected.
 *
 * The glue is Emscripten's. Under workerd's `nodejs_compat` its Node sniff
 * reads true, takes the Node branch and calls `createRequire(import.meta.url)`
 * with no URL, which throws. Nothing here uses that branch: the Wasm modules
 * are handed in already compiled. So the copy pins the sniff to false.
 *
 * The glue also keeps its one runtime for good. A runtime that has run out of
 * memory is dead, so the copy exports `discardRuntime`, after which the next
 * `Parser.init()` makes a new one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SNIFF =
  '  var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";\n';
const PINNED = "  var ENVIRONMENT_IS_NODE = false;\n";
const RUNTIME = "  return Module3 ??= await web_tree_sitter_default(moduleOptions);\n";
const DISCARD = "export function discardRuntime() {\n  Module3 = null;\n}\n";

const glue = readFileSync(fileURLToPath(import.meta.resolve("web-tree-sitter")), "utf8");
if (glue.split(SNIFF).length !== 2)
  throw new Error("web-tree-sitter's glue no longer has the one Node sniff this script pins");
if (glue.split(RUNTIME).length !== 2)
  throw new Error("web-tree-sitter's glue no longer keeps its runtime where this script expects");
const pinned =
  glue.replace(SNIFF, PINNED).replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n") + DISCARD;

const version = (name: string): string => {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest))
    throw new Error(`${name} has no version`);
  return `${name}@${String(manifest.version)}`;
};

const out = new URL("../src/generated/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("web-tree-sitter.js", out), pinned);
writeFileSync(
  new URL("web-tree-sitter.d.ts", out),
  'export * from "web-tree-sitter";\nexport function discardRuntime(): void;\n',
);
writeFileSync(
  new URL("versions.ts", out),
  `export const PARSER_PACKAGES = ${JSON.stringify(`${version("web-tree-sitter")} ${version("tree-sitter-typescript")}`)};\n`,
);
