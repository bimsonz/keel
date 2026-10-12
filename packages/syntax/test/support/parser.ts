import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootParser, ParserStarting, type SourceParser } from "../../src/index.ts";

const compiled = (specifier: string): WebAssembly.Module =>
  new WebAssembly.Module(readFileSync(fileURLToPath(import.meta.resolve(specifier))));

/** The two Wasm modules, compiled from the packages' own files. */
export const WASM = {
  runtime: compiled("web-tree-sitter/web-tree-sitter.wasm"),
  grammar: compiled("tree-sitter-typescript/tree-sitter-typescript.wasm"),
};

/** The parser, booted in this process; a boot under way elsewhere is waited out. */
export async function parser(): Promise<SourceParser> {
  for (;;)
    try {
      return await bootParser(WASM);
    } catch (error) {
      if (!(error instanceof ParserStarting)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
}
