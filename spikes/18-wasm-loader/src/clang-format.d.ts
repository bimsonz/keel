// The package types only its ./esm, ./node and ./web entries; the children import
// the Emscripten factory and the binding directly (see children/clang.ts).
declare module "@wasm-fmt/clang-format/clang-format.js" {
  export function createModule(opts: { wasm: WebAssembly.Module }): unknown;
}
declare module "@wasm-fmt/clang-format/clang-format-binding.js" {
  export function set_wasm(wasm: unknown): void;
  export function format(content: string, filename?: string, style?: string): string;
}
