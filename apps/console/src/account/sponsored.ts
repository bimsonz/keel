// The agents a person sponsors, and what that person may ask of each: pause it, unpause it, stop sponsoring it.
// Keel lists them to their sponsor (`Agents_listSponsored`) and takes each move from the sponsor alone. Nothing
// here works out whose an agent is: the list is Keel's, and a row says what Keel last answered of its agent.

import type { AgentProfile } from "../contract/keel/index.ts";

/** What a sponsor may ask of an agent. */
export type Control = "pause" | "unpause" | "end";

/** What a pause says where its sponsor gave no reason. Keel keeps a reason with every pause. */
export const PAUSED_BY_SPONSOR = "Paused by its sponsor";

/** The reason a pause carries: what the sponsor typed, or that sentence where they typed nothing. */
export const reasonOf = (typed: string): string =>
  typed.trim() === "" ? PAUSED_BY_SPONSOR : typed.trim();

/**
 * The controls an agent's standing leaves its sponsor. An active agent is paused and a paused one unpaused.
 * The link is ended however the agent stands: Keel reinstates a paused agent as its link ends. An agent Keel
 * has revoked, or one whose standing Keel did not say, is neither paused nor unpaused.
 */
export function controlsOf(state: AgentProfile["state"]): Control[] {
  switch (state) {
    case "active":
      return ["pause", "end"];
    case "suspended":
      return ["unpause", "end"];
    default:
      return ["end"];
  }
}

/** How an agent stands, in a sponsor's words: Keel's `suspended` is their pause. Nothing where Keel said nothing. */
export function standingOf(state: AgentProfile["state"]): string {
  switch (state) {
    case "active":
      return "Active";
    case "suspended":
      return "Paused";
    case "revoked":
      return "Revoked";
    default:
      return "";
  }
}

/**
 * The list once Keel has answered a move with the agent as it now is: its row says what Keel answered, and an
 * agent Keel no longer names this reader the sponsor of has no row.
 */
export function afterMove(
  listed: readonly AgentProfile[],
  answered: AgentProfile,
  reader: string,
): AgentProfile[] {
  return listed.flatMap((agent) => {
    if (agent.id !== answered.id) return [agent];
    return answered.sponsor === reader ? [answered] : [];
  });
}
