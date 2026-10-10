declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./host.ts");
  }
}
