import type { Effect } from "effect";
import type { SubjectKey } from "../../domain/coordination/index.ts";
import type { Principal } from "../../domain/identity/index.ts";
import type { DecisionId, EscalationId } from "../../domain/kernel/index.ts";
import type {
  Decision,
  DecisionNotFound,
  NothingToExplain,
  WhyLink,
} from "../../domain/memory/index.ts";
import type { EscalationNotFound } from "../../domain/verification/index.ts";
import { stub } from "../not-implemented.ts";
import type { Clock, EntityStore, EventOutbox, Ids, SubjectRegistry } from "../ports/index.ts";

/** memory use-cases reachable from the API. Signatures are fixed here. */

export type WhyTarget =
  | { readonly kind: "line"; readonly path: string; readonly line: number }
  | { readonly kind: "subject"; readonly subject: SubjectKey };

export const why: (
  principal: Principal,
  target: WhyTarget,
) => Effect.Effect<readonly WhyLink[], NothingToExplain, EntityStore | SubjectRegistry> =
  stub("memory/why");

export const listDecisions: (
  principal: Principal,
  subject: SubjectKey | undefined,
) => Effect.Effect<readonly Decision[], never, EntityStore | SubjectRegistry> =
  stub("memory/listDecisions");

export const getDecision: (
  principal: Principal,
  decisionId: DecisionId,
) => Effect.Effect<Decision, DecisionNotFound, EntityStore> = stub("memory/getDecision");

export const giveRuling: (
  principal: Principal,
  input: {
    readonly escalationId: EscalationId;
    readonly option: string;
    readonly rationale?: string;
  },
) => Effect.Effect<Decision, EscalationNotFound, EntityStore | EventOutbox | Ids | Clock> =
  stub("memory/giveRuling");

export * from "./feed.ts";
