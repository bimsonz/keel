import {
  exposure,
  type Intent,
  type LiveChange,
  type Preflight,
  preflight,
  type ScopedPrecedent,
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
 * and the domain's `preflight` the move and what it rests on, with the
 * precedents in scope (the decisions in force on the subjects the intent
 * names). Advisory: fallout on the Subject DO is what judges.
 */
export function preflightFor(
  self: ChangeId,
  intent: Intent,
  live: readonly LiveChange[],
  precedents: readonly ScopedPrecedent[],
): PreflightFinding {
  const found = exposure(self, intent, live);
  return {
    preflight: preflight(self, intent, found, precedents),
    unreadable: found.unreadable.length,
  };
}
