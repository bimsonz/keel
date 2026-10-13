// What a project's own log says of its decisions, beside Keel's read of each.

import type { NextAction } from "../contract/events.ts";

/** Keel's operation that reads one decision. A next action that names it cites that decision. */
const READS_A_DECISION = "Memory_getDecision";

/**
 * The decision a bounce cites: the one its next actions say to read. It is taken from the action's own
 * argument, as Keel wrote it for an agent to follow, and never read out of a sentence. A bounce that names no
 * such action cites none.
 */
export function citedIn(nextActions: readonly NextAction[]): string | undefined {
  for (const action of nextActions) {
    const id = action.operationId === READS_A_DECISION ? action.args?.["decisionId"] : undefined;
    if (typeof id === "string" && id !== "") return id;
  }
  return undefined;
}
