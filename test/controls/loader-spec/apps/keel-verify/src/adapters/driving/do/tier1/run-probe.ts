// Control for loader-spec: Tier 1 isolates handed a network, an env, a spec
// the guard cannot read, or the loader itself.
declare const env: { LOADER: { get(id: string, code: () => unknown): unknown } };
declare const shared: Record<string, unknown>;
declare const parentEnv: Record<string, unknown>;
declare function pass(loader: unknown): void;

env.LOADER.get("fine", () => ({ mainModule: "m.js", modules: {}, globalOutbound: null }));
env.LOADER.get("open", () => ({ mainModule: "m.js", modules: {} }));
env.LOADER.get("fetcher", () => ({ mainModule: "m.js", modules: {}, globalOutbound: shared }));
env.LOADER.get("bindings", () => ({ mainModule: "m.js", modules: {}, globalOutbound: null, env: parentEnv }));
env.LOADER.get("spread", () => ({ ...shared, globalOutbound: null }));
env.LOADER.get("built", () => shared);
const loader = env.LOADER;
pass(loader);
const { LOADER } = env;
pass(LOADER);
