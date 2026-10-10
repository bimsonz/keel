// keel-spike-18-tools: the same child bundles, deployed as one static Worker.
// wrangler resolves each bundle's ./<name>.wasm import as a CompiledWasm module.
// @ts-expect-error generated bundle (scripts/build-children.ts)
import clang from "../build/wasm/child-clang.js";
// @ts-expect-error generated bundle
import compileprobe from "../build/wasm/child-compileprobe.js";
// @ts-expect-error generated bundle
import fetchprobe from "../build/wasm/child-fetchprobe.js";
// @ts-expect-error generated bundle
import hcl from "../build/wasm/child-hcl.js";
// @ts-expect-error generated bundle
import ruff from "../build/wasm/child-ruff.js";
// @ts-expect-error generated bundle
import treesitter from "../build/wasm/child-treesitter.js";

type Child = { fetch(req: Request): Promise<Response> };
const routes: Record<string, Child> = { clang, compileprobe, fetchprobe, hcl, ruff, treesitter };

export default {
  async fetch(req: Request): Promise<Response> {
    const tool = new URL(req.url).pathname.slice(1);
    const child = routes[tool];
    if (!child) return new Response(`unknown tool ${tool}`, { status: 404 });
    return child.fetch(req);
  },
} satisfies ExportedHandler;
