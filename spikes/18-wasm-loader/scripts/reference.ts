// Runs the four tools locally in Node through each package's normal Node entry
// (bytes from disk, runtime compile allowed) and writes results/reference.json.
// The edge results are compared to this byte-for-byte after JSON normalisation.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, PositionEncoding, Workspace } from "@astral-sh/ruff-wasm-web";
import { format as clangFormat } from "@wasm-fmt/clang-format";
import { Language, Parser } from "web-tree-sitter";
import { clangResult, hclResult, ruffResult, treeSitterResult } from "../src/shape.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (f: string) => readFileSync(join(root, "fixtures", f), "utf8");
const nm = (p: string) => join(root, "node_modules", p);

initSync({ module: readFileSync(nm("@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm")) });
const ruff = ruffResult(new Workspace(Workspace.defaultSettings(), PositionEncoding.Utf16), fixture("sample.py"));

const clang = clangResult(clangFormat(fixture("sample.c"), "main.c", "LLVM"));

const require = createRequire(join(root, "package.json"));
const hcl2json = require("@cdktf/hcl2json") as { parse(f: string, s: string): Promise<unknown> };
const hcl = hclResult(JSON.stringify(await hcl2json.parse("main.tf", fixture("main.tf"))));

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(readFileSync(nm("tree-sitter-typescript/tree-sitter-typescript.wasm"))));
const tree = parser.parse(fixture("sample.ts"));
if (!tree) throw new Error("tree-sitter: parse returned null");
const treesitter = treeSitterResult(tree);

const out = { generatedWith: { node: process.version }, ruff, clang, hcl, treesitter };
writeFileSync(join(root, "results", "reference.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ ruff: ruff.diagnostics.map((d) => d.code), treesitter }, null, 0));
process.exit(0); // the Go runtime inside hcl2json keeps the event loop alive
