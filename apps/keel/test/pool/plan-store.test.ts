// The PlanStore contract on the R2 adapter over keel's real ARCHIVE binding:
// plans written and read through R2, and tampered entries planted straight
// into the bucket at the key the adapter reads.
import { env } from "cloudflare:workers";
import { PORTS } from "@keeltown/testing";
import { Effect } from "effect";
import { planKey, PlanStoreR2 } from "../../src/adapters/driven/r2/plan-store.ts";

PORTS.PlanStore.contract("r2 (ARCHIVE)", () => ({
  layer: PlanStoreR2(env.ARCHIVE),
  plant: (hash, text) =>
    Effect.promise(() => env.ARCHIVE.put(planKey(hash), text)).pipe(Effect.asVoid),
}));
