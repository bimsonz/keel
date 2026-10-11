import {
  exposure,
  type Intent,
  type LiveChange,
  type Preflight,
  preflight,
} from "../../domain/coordination/index.ts";
import type { ChangeId } from "../../domain/kernel/index.ts";

/** What preflight found, and the propositions exposure could not read. */
export interface PreflightFinding {
  readonly preflight: Preflight;
  /** How many propositions exposure could not compare; logged until the domain's preflight says how an agent hears of them. */
  readonly unreadable: number;
}

/**
 * The preflight of `intent` for change `self` against its project's live
 * changes: the domain's `exposure` gives the neighbours and contradictions,
 * and the domain's `preflight` the move and what it rests on. No precedent is
 * in scope until decisions are kept. Advisory: fallout on the Subject DO is
 * what judges.
 */
export function preflightFor(
  self: ChangeId,
  intent: Intent,
  live: readonly LiveChange[],
): PreflightFinding {
  const found = exposure(self, intent, live);
  return {
    preflight: preflight(self, intent, found, []),
    unreadable: found.unreadable.length,
  };
}
