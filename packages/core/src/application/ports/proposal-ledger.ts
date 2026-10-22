import { Context, type Effect } from "effect";
import type { ProposalLimit } from "../../domain/coordination/index.ts";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import type { ChangeId, ProjectId } from "../../domain/kernel/index.ts";
import type { ProposalRelease, ProposalReservation } from "../coordination/index.ts";

/**
 * A project's proposal ledger, in its object (`project:<projectId>`): the
 * change id of a proposal to it, reserved by its proposer's Idempotency-Key,
 * and the cap on what one proposer has open there (`reserveProposal`).
 */
export class ProposalLedger extends Context.Service<
  ProposalLedger,
  {
    readonly reserve: (
      projectId: ProjectId,
      reservation: ProposalReservation,
    ) => Effect.Effect<ChangeId, ProposalLimit | IdempotencyConflict>;
    /**
     * Gives back at once the place a key reserved whose proposal has not
     * arrived: it was refused before it was made. A retry of the key is a new
     * reservation; an arrived proposal, or a key that reserved nothing, keeps
     * what it has.
     */
    readonly release: (projectId: ProjectId, release: ProposalRelease) => Effect.Effect<void>;
  }
>()("keel/ProposalLedger") {}
