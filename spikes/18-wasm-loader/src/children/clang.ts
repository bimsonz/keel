// Glue: Emscripten factory createModule({ wasm }). Its readBinary() returns
// Module.wasm and instantiateSync() skips compilation when that is already a
// WebAssembly.Module. The package's own ESM entry uses `import source`, which the
// bundler and workerd do not take, so this imports the factory directly.
import { createModule } from "@wasm-fmt/clang-format/clang-format.js";
import { format, set_wasm } from "@wasm-fmt/clang-format/clang-format-binding.js";
import { clangResult } from "../shape.ts";
import { serve } from "./common.ts";
import wasm from "./clang-format.wasm";

let ready = false;

export default serve("clang-format", (src) => {
  if (!ready) {
    set_wasm(createModule({ wasm }));
    ready = true;
  }
  return clangResult(format(src, "main.c", "LLVM"));
});
