import type { Effect } from "effect";
import type { DeployEvidence, DeploymentFailed } from "../../domain/delivery/index.ts";
import type { CandidateId } from "../../domain/kernel/index.ts";
import { stub } from "../not-implemented.ts";
import type { BundleStore, Deployer } from "../ports/index.ts";

/** delivery use-cases. The Deployer adapters land in L5; the signature is fixed now. */

export const previewCandidate: (candidateId: CandidateId) => Effect.Effect<DeployEvidence, DeploymentFailed, Deployer | BundleStore> =
  stub("delivery/previewCandidate");
