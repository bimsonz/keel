// Bundles one probe against one world for a Tier 1 child, with
// @cloudflare/worker-bundler (esbuild-wasm inside the host). Dependencies are
// installed once per host isolate and reused, so each bundle is one esbuild
// call. An esbuild failure comes back as text: that is the "compile error" a
// repair attempt is given verbatim.
import { createWorker, InMemoryFileSystem, installDependencies } from "@cloudflare/worker-bundler";
// oxlint-disable-next-line import/default -- loaded as a Text module; typed by vitest-shim.d.ts
import shimSource from "./child/vitest-shim.js";
// oxlint-disable-next-line import/default -- loaded as a Text module; typed by vitest-shim.d.ts
import runnerSource from "./child/runner.js";

// The shim is written against these versions (S14).
const SHIM_DEPS: Record<string, string> = {
  "@vitest/expect": "5.0.3",
  "@vitest/spy": "5.0.3",
  "@vitest/utils": "5.0.3",
  chai: "^6.2.2",
};

export const PROBE_PATH = "probe/probe.test.ts";

export interface ProbeBundle {
  mainModule: string;
  modules: Record<string, string>;
  bytes: number;
}

let installed: Promise<Record<string, string>> | undefined;

/** node_modules for forge-lite's runtime deps plus the shim's, fetched once per isolate. */
function nodeModules(worldPackageJson: string): Promise<Record<string, string>> {
  installed ??= (async () => {
    const pkg = JSON.parse(worldPackageJson) as { dependencies?: Record<string, string> };
    const fs = new InMemoryFileSystem({
      "package.json": JSON.stringify({ name: "probe", private: true, type: "module", dependencies: { ...pkg.dependencies, ...SHIM_DEPS } }),
    });
    await installDependencies(fs);
    const files: Record<string, string> = {};
    for (const p of fs.list("node_modules/")) files[p] = fs.read(p)!;
    return files;
  })();
  installed.catch(() => {
    installed = undefined;
  });
  return installed;
}

export async function bundleProbe(world: Record<string, string>, probe: string): Promise<{ bundle?: ProbeBundle; error?: string }> {
  const deps = await nodeModules(world["package.json"] ?? "{}");
  const fs = new InMemoryFileSystem({
    ...deps,
    ...world,
    [PROBE_PATH]: probe,
    "__keel/shim.js": shimSource,
    "__keel/runner.js": runnerSource,
  });
  try {
    const out = await createWorker({
      files: fs,
      entryPoint: "__keel/runner.js",
      virtualModules: { vitest: `export * from "/__keel/shim.js";` },
      minify: false,
    });
    const modules: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.modules)) {
      if (typeof v !== "string") return { error: `unexpected non-text module ${k} in the probe bundle` };
      modules[k] = v;
    }
    const bytes = Object.values(modules).reduce((a, s) => a + new TextEncoder().encode(s).length, 0);
    return { bundle: { mainModule: out.mainModule, modules, bytes } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
