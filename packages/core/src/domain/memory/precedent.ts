import type { Proposition, ScopedPrecedent } from "../coordination/index.ts";
import type { Decision } from "./memory.ts";

/**
 * The precedent a decision scopes for preflight, with the propositions it
 * upheld (`holds`, from the conflict it ruled). A decision superseded or
 * overruled scopes none: the decision that ended it is the precedent from then
 * on, with only what it upheld itself.
 */
export const scopedPrecedent = (
  decision: Decision,
  upheld: readonly Proposition[],
): ScopedPrecedent | undefined =>
  decision.state === "active"
    ? {
        ref: {
          decisionId: decision.id,
          summary: decision.summary,
          decidedAt: decision.decidedAt,
          ...(decision.scope === undefined ? {} : { scope: decision.scope }),
        },
        holds: upheld,
      }
    : undefined;
