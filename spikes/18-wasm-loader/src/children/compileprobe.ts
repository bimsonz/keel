// Runtime-compile probe: the same 39-byte module arrives twice, as raw bytes
// ({data}) and as a module ({wasm}). Compiling the bytes must be refused;
// instantiating the module must work (the control).
import { serve } from "./common.ts";
import bytes from "./tiny.bin";
import mod from "./tiny.wasm";

async function attempt(name: string, f: () => unknown): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    const v = await f();
    return { name, ok: true, detail: typeof v === "object" && v !== null ? v.constructor.name : String(v) };
  } catch (e) {
    const err = e as Error;
    return { name, ok: false, detail: `${err.name}: ${err.message}` };
  }
}

// workers-types omits WebAssembly.compile and makes Module abstract, because workerd
// refuses both; call them through an untyped view to see what the runtime does.
const W = WebAssembly as unknown as {
  validate(b: ArrayBuffer): boolean;
  compile(b: ArrayBuffer): Promise<WebAssembly.Module>;
  instantiate(b: ArrayBuffer): Promise<unknown>;
  Module: new (b: ArrayBuffer) => WebAssembly.Module;
};

export default serve("compileprobe", async () => {
  const buf = bytes as ArrayBuffer;
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return {
    runtime: { processType: typeof proc, processVersionsNode: proc?.versions?.node ?? null },
    byteLength: buf.byteLength,
    attempts: [
      await attempt("WebAssembly.validate(bytes)", () => W.validate(buf)),
      await attempt("new WebAssembly.Module(bytes)", () => new W.Module(buf)),
      await attempt("WebAssembly.compile(bytes)", () => W.compile(buf)),
      await attempt("WebAssembly.instantiate(bytes)", () => W.instantiate(buf)),
      await attempt("control: new WebAssembly.Instance(module).answer()", () =>
        (new WebAssembly.Instance(mod, {}).exports.answer as () => number)(),
      ),
    ],
  };
});
