import grammar from "tree-sitter-typescript/tree-sitter-typescript.wasm";
import runtime from "web-tree-sitter/web-tree-sitter.wasm";
import type { SyntaxWasm } from "@keeltown/syntax";

/**
 * tree-sitter's runtime and its TypeScript grammar as the Worker's own
 * modules: wrangler compiles each `.wasm` import at deploy, so nothing is
 * fetched or compiled at run time.
 */
export const SYNTAX_WASM: SyntaxWasm = { runtime, grammar };
