// Glue: web-tree-sitter (Emscripten). Two wasm modules arrive from the modules map:
//  - the runtime, instantiated through Parser.init({ instantiateWasm }) instead of
//    the default fetch(new URL("web-tree-sitter.wasm", import.meta.url));
//  - the grammar, a dynamically-linked side module, loaded with Language.loadSync(module),
//    which reads the dylink.0 section via WebAssembly.Module.customSections and
//    instantiates without compiling. Language.load(bytes|url) would compile at runtime.
import { Language, Parser } from "web-tree-sitter";
import { treeSitterResult } from "../shape.ts";
import { memoryOf, serve } from "./common.ts";
import runtime from "./tree-sitter.wasm";
import grammar from "./tree-sitter-typescript.wasm";

let parser: Parser | undefined;
let instance: WebAssembly.Instance | undefined;

async function get(): Promise<Parser> {
  if (!parser) {
    await Parser.init({
      instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
        instance = new WebAssembly.Instance(runtime, imports);
        done(instance, runtime);
        return instance.exports;
      },
    } as never);
    const p = new Parser();
    p.setLanguage(Language.loadSync(grammar));
    parser = p;
  }
  return parser;
}

export default serve(
  "tree-sitter",
  async (src) => {
    const tree = (await get()).parse(src);
    if (!tree) throw new Error("parse returned null");
    try {
      return treeSitterResult(tree);
    } finally {
      tree.delete();
    }
  },
  () => memoryOf(instance),
);
