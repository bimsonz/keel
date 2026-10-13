// The EvidenceStore contract on the R2 adapter over keel's real ARCHIVE binding:
// documents written and read through R2, each under its namespace's key.
import { env } from "cloudflare:workers";
import { PORTS } from "@keeltown/testing";
import { EvidenceStoreR2 } from "../../src/adapters/driven/r2/evidence-store.ts";

PORTS.EvidenceStore.contract("r2 (ARCHIVE)", () => EvidenceStoreR2(env.ARCHIVE));
