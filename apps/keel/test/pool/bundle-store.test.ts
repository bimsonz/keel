// The BundleStore contract on the R2 adapter over keel's real BUNDLES binding:
// bundles written and read through R2, each under its namespace's key.
import { env } from "cloudflare:workers";
import { PORTS } from "@keeltown/testing";
import { BundleStoreR2 } from "../../src/adapters/driven/r2/bundle-store.ts";

PORTS.BundleStore.contract("r2 (BUNDLES)", () => BundleStoreR2(env.BUNDLES));
