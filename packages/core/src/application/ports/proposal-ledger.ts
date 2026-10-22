import { Context, type Effect } from "effect";
import type { ProposalLimit } from "../../domain/coordination/index.ts";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import type { ChangeId, ProjectId } from "../../domain/kernel/index.ts";
import type { ProposalReservation } from "../coordination/index.ts";

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
  }
>()("keel/ProposalLedger") {}
