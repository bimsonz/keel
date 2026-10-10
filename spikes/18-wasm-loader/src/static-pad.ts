// keel-spike-18-static-pad: one padded module as a static CompiledWasm import, to
// find what `wrangler deploy` accepts. scripts/static-pad.sh copies the chosen
// pad-<mb>-<mode>.wasm to build/wasm/pad-static.wasm before each deploy.
import wasm from "../build/wasm/pad-static.wasm";

export default {
  fetch(): Response {
    const inst = new WebAssembly.Instance(wasm, {});
    return Response.json({ probe: (inst.exports.probe as () => number)() });
  },
} satisfies ExportedHandler;
