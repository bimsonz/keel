// Glue: wasm-bindgen --target web. initSync() accepts a WebAssembly.Module, so the
// module from the loader's modules map is handed over unchanged.
import { initSync, PositionEncoding, Workspace } from "@astral-sh/ruff-wasm-web";
import { ruffResult } from "../shape.ts";
import { serve } from "./common.ts";
import wasm from "./ruff.wasm";

let ws: Workspace | undefined;
let memory: WebAssembly.Memory | undefined;

function workspace(): Workspace {
  if (!ws) {
    memory = initSync({ module: wasm }).memory;
    ws = new Workspace(Workspace.defaultSettings(), PositionEncoding.Utf16);
  }
  return ws;
}

export default serve("ruff", (src) => ruffResult(workspace(), src), () => memory?.buffer.byteLength ?? null);
