import type { createWorker } from "@cloudflare/worker-bundler";
import { PROBE_VITEST_SOURCE, type ProbeWorker } from "@keeltown/runner-protocol";

/**
 * The registry worker-bundler would install from, were it ever to try: a
 * second fence behind the refusal below, since nothing answers `.invalid`.
 */
export const NO_REGISTRY = "https://registry.invalid";

/** worker-bundler would install packages, which means fetching from npm inside the VerifierDO: refused. */
export class BundlerFenced extends Error {
  constructor() {
    super(
      "worker-bundler would install dependencies; a probe's deps come from its deps bundle only",
    );
    this.name = "BundlerFenced";
  }
}

/** The probe would not bundle (a missing export such as `vi`, a syntax error): the probe's fault. */
export class ProbeUnbundlable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProbeUnbundlable";
  }
}

export type BundledProbe = Pick<Awaited<ReturnType<typeof createWorker>>, "mainModule" | "modules">;

/**
 * Bundles a mounted probe for a Tier 1 isolate: its world, its deps bundle's
 * node_modules and Keel's own `vitest`, with esbuild-wasm. The VerifierDO
 * has outbound fetch, so the LOADER's `globalOutbound: null` does not cover
 * this step: worker-bundler 0.2.6 installs from npm whenever the files
 * declare a dependency (`hasDependencies`). The mount strips every one, this
 * refuses to go on if any is left, and the registry is one that cannot answer.
 */
export async function bundleProbe(worker: ProbeWorker): Promise<BundledProbe> {
  // Loaded on first use: esbuild-wasm's glue is large, and keel-verify's other paths (/healthz, Tier 2) never need it.
  const { createWorker, hasDependencies, InMemoryFileSystem } =
    await import("@cloudflare/worker-bundler");
  const files = new InMemoryFileSystem({ ...worker.files });
  if (hasDependencies(files)) throw new BundlerFenced();
  try {
    const built = await createWorker({
      files,
      entryPoint: worker.entry,
      virtualModules: { vitest: PROBE_VITEST_SOURCE },
      registry: NO_REGISTRY,
    });
    return { mainModule: built.mainModule, modules: built.modules };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new ProbeUnbundlable(
      `the probe did not bundle: ${text.split("\n").slice(0, 4).join(" ")}`,
    );
  }
}
