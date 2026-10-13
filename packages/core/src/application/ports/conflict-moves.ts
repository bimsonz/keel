import { Context, type Effect } from "effect";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import type { Move } from "../../domain/coordination/index.ts";
import type { AgentId, ChangeId, ConflictId, RunRef, UserId } from "../../domain/kernel/index.ts";
import type { ConflictNotFound, MoveRefused } from "../../domain/verification/index.ts";
import type { ConflictView, SubjectRef } from "./probe-ledger.ts";

export interface ResolveCommand {
  readonly conflictId: ConflictId;
  /** The party making the move. */
  readonly changeId: ChangeId;
  readonly agentId: AgentId;
  /** The run of the agent that makes the move, when its token names one. */
  readonly run?: RunRef | undefined;
  /** Who vouches for that agent: asked first when the move is `escalate`. */
  readonly sponsor?: UserId | undefined;
  readonly move: Move;
  /** The agent's own words for the person asked. */
  readonly note?: string | undefined;
  readonly idempotencyKey: string;
}

/**
 * A party's move on a conflict, made at the Subject DO that hosts it. The
 * doorway has already checked the party's lease.
 */
export class ConflictMoves extends Context.Service<
  ConflictMoves,
  {
    readonly resolve: (
      at: SubjectRef,
      command: ResolveCommand,
    ) => Effect.Effect<ConflictView, ConflictNotFound | MoveRefused | IdempotencyConflict>;
  }
>()("keel/ConflictMoves") {}
