import {
  hearProposal,
  releaseProposal,
  reserveProposal,
} from "@keeltown/core/application/coordination";
import type { EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import { ProposalLedger } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeClockMemory, makeIdsMemory } from "./identity.ts";
import { makeEntityStoreMemory } from "./storage.ts";

/**
 * Each project's proposal ledger in memory, run by the Project DO's own
 * use-cases over a store of its own: `hear` delivers a proposal's event to
 * its project's ledger, as the object's reaction does.
 */
export function makeProposalLedgerMemory() {
  const stores = new Map<ProjectId, ReturnType<typeof makeEntityStoreMemory>>();
  const storeOf = (projectId: ProjectId) => {
    const held = stores.get(projectId);
    if (held !== undefined) return held;
    const made = makeEntityStoreMemory();
    stores.set(projectId, made);
    return made;
  };
  const ids = makeIdsMemory();
  const clock = makeClockMemory();
  return {
    hear: (projectId: ProjectId, event: EventEnvelope) => {
      const { service } = storeOf(projectId);
      service.transaction(() => hearProposal(service, event));
    },
    layer: Layer.succeed(
      ProposalLedger,
      ProposalLedger.of({
        reserve: (projectId, reservation) =>
          reserveProposal(projectId, reservation).pipe(
            Effect.provide(Layer.mergeAll(storeOf(projectId).layer, ids.layer, clock.layer)),
          ),
        release: (projectId, release) =>
          releaseProposal(release).pipe(Effect.provide(storeOf(projectId).layer)),
      }),
    ),
  };
}
