import type { Effect } from "effect";
import type { AgentToken } from "../../domain/identity/index.ts";
import type { ChangeId, ConflictId } from "../../domain/kernel/index.ts";
import type { Conflict, ConflictNotFound, ConflictState } from "../../domain/verification/index.ts";
import { stub } from "../not-implemented.ts";
import type { EntityStore } from "../ports/index.ts";

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

export const listConflicts: (
  principal: AgentToken,
  query: ConflictQuery,
) => Effect.Effect<ConflictPage, never, EntityStore> = stub("verification/listConflicts");

export const getConflict: (
  principal: AgentToken,
  conflictId: ConflictId,
) => Effect.Effect<Conflict, ConflictNotFound, EntityStore> = stub("verification/getConflict");

export * from "./command.ts";
export * from "./deps.ts";
export * from "./derive-submission.ts";
export * from "./draft-probe.ts";
export * from "./flow-spec.ts";
export * from "./guard-file.ts";
export * from "./guard-step.ts";
export * from "./namespace-keys.ts";
export * from "./packs.ts";
export * from "./plan-codec.ts";
export * from "./precheck.ts";
export * from "./probe-conflict.ts";
export * from "./probe-run.ts";
export * from "./probe-workflow.ts";
export * from "./project-namespace.ts";
export * from "./probe-templates/freshness.ts";
export * from "./probe-templates/template.ts";
export * from "./redact.ts";
export * from "./run-matrix.ts";
export * from "./run-plan.ts";
export * from "./runner-output.ts";
export * from "./suite.ts";
export * from "./typecheck.ts";
export * from "./verdict-index.ts";
export * from "./verify-candidate.ts";
export * from "./verify-plan.ts";
export * from "./world-check.ts";
export * from "./world-check-plan.ts";
export * from "./world-matrix.ts";
