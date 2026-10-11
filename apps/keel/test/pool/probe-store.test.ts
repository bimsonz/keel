// The ProbeStore contract on the R2 adapter over keel's real BUNDLES binding,
// each probe read back from its bundle exactly as a VerifierDO reads it.
import { env } from "cloudflare:workers";
import { PORTS } from "@keeltown/testing";
import { readBundle } from "@keeltown/runner-protocol";
import { Effect } from "effect";
import { bundleKey } from "../../src/adapters/driven/r2/bundle-store.ts";
import { ProbeStoreR2 } from "../../src/adapters/driven/r2/probe-store.ts";

const dec = new TextDecoder();

PORTS.ProbeStore.contract("r2 (BUNDLES)", () => ({
  layer: ProbeStoreR2(env.BUNDLES),
  read: (hash) =>
    Effect.promise(async () => {
      const object = await env.BUNDLES.get(bundleKey(hash));
      if (object === null) return undefined;
      const files = await readBundle(new Uint8Array(await object.arrayBuffer()));
      return files.map((f) => ({ path: f.path, text: dec.decode(f.bytes) }));
    }),
}));
