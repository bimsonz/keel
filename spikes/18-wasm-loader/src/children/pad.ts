// Size-ceiling probe: instantiate a padded module (active segment = payload is
// copied into linear memory; passive = payload stays in the module bytes) and read
// probe(), which for active modules is the last 4 payload bytes.
import { memoryOf, serve } from "./common.ts";
import wasm from "./pad.wasm";

let instance: WebAssembly.Instance | undefined;

export default serve(
  "pad",
  () => {
    instance ??= new WebAssembly.Instance(wasm, {});
    return { probe: (instance.exports.probe as () => number)() };
  },
  () => memoryOf(instance),
);
