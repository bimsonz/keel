import type { Effect } from "effect";
import type { Move } from "../../domain/coordination/index.ts";
import type { Principal } from "../../domain/identity/index.ts";
import type { ChangeId, ConflictId, LeaseId, VerdictId } from "../../domain/kernel/index.ts";
import type {
  Conflict,
  ConflictNotFound,
  ConflictState,
  MoveRefused,
  VerdictNotFound,
  VerdictOutcome,
} from "../../domain/verification/index.ts";
import { stub } from "../not-implemented.ts";
import type { EntityStore, EventOutbox, HumanGate } from "../ports/index.ts";

/** verification use-cases reachable from the API. Their signatures are fixed here. */

export interface ConflictQuery {
  readonly changeId?: ChangeId;
  readonly state?: ConflictState;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ConflictPage {
  readonly items: readonly Conflict[];
  readonly nextCursor?: string;
}

export interface ResolveInput {
  readonly conflictId: ConflictId;
  readonly changeId: ChangeId;
  readonly lease: LeaseId;
  readonly move: Move;
  readonly note?: string;
}

export interface VerdictView {
  readonly id: VerdictId;
  readonly outcome: VerdictOutcome;
  readonly evidence: readonly string[];
}

export const listConflicts: (
  principal: Principal,
  query: ConflictQuery,
) => Effect.Effect<ConflictPage, never, EntityStore> = stub("verification/listConflicts");

export const getConflict: (
  principal: Principal,
  conflictId: ConflictId,
) => Effect.Effect<Conflict, ConflictNotFound, EntityStore> = stub("verification/getConflict");

export const resolveConflict: (
  principal: Principal,
  input: ResolveInput,
) => Effect.Effect<
  Conflict,
  ConflictNotFound | MoveRefused,
  EntityStore | EventOutbox | HumanGate
> = stub("verification/resolveConflict");

export const getVerdict: (
  principal: Principal,
  verdictId: VerdictId,
) => Effect.Effect<VerdictView, VerdictNotFound, EntityStore> = stub("verification/getVerdict");

export * from "./flow-spec.ts";
export * from "./packs.ts";
export * from "./plan-codec.ts";
export * from "./precheck.ts";
export * from "./probe-run.ts";
export * from "./probe-templates/freshness.ts";
export * from "./redact.ts";
export * from "./run-matrix.ts";
export * from "./run-plan.ts";
export * from "./runner-output.ts";
export * from "./suite.ts";
export * from "./typecheck.ts";
export * from "./verify-candidate.ts";
export * from "./world-matrix.ts";
