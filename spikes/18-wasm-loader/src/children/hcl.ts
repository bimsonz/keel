// Glue: Go's wasm_exec.js (GOOS=js GOARCH=wasm) from @cdktf/hcl2json. The package's
// own bridge reads main.wasm.gz from disk and calls WebAssembly.instantiate(bytes);
// here the module arrives pre-compiled (decompressed before upload) and is
// instantiated with new WebAssembly.Instance(module, go.importObject).
// wasm_exec.js installs its own fs/process stubs when globalThis lacks them.
// oxlint-disable-next-line import/no-unassigned-import -- wasm_exec.js only defines globalThis.Go
import "@cdktf/hcl2json/wasm/wasm_exec.js";
import { hclResult } from "../shape.ts";
import { memoryOf, serve } from "./common.ts";
import wasm from "./hcl2json.wasm";

type GoFn = (...args: unknown[]) => void;
type GoRuntime = { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
const G = globalThis as unknown as {
  Go: new () => GoRuntime;
  // The Go program registers its exports on this global; the name is fixed in its main().
  // oxlint-disable-next-line no-underscore-dangle
  __parse_terraform_config_wasm__?: Record<string, GoFn>;
};

let root: Record<string, GoFn> | undefined;
let instance: WebAssembly.Instance | undefined;

function start(): Record<string, GoFn> {
  if (!root) {
    const go = new G.Go();
    instance = new WebAssembly.Instance(wasm, go.importObject);
    root = {};
    // oxlint-disable-next-line no-underscore-dangle -- name fixed by the Go program
    G.__parse_terraform_config_wasm__ = root;
    void go.run(instance); // main() registers its functions on root, then parks.
  }
  return root;
}

export default serve(
  "hcl2json",
  async (src) => {
    const fns = start();
    if (typeof fns.parse !== "function") throw new Error(`go exports: ${Object.keys(fns).join(",")}`);
    const json = await new Promise<string>((resolve, reject) =>
      fns.parse("main.tf", src, (err: unknown, out: string) => (err ? reject(new Error(String(err))) : resolve(out))),
    );
    return hclResult(json);
  },
  () => memoryOf(instance),
);
