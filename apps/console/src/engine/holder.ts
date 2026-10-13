// Who holds a change, and under which run: what a change's row and its page
// say of it, and where they link to. The log names the holder by its id and
// the run by Keel's id for it; the agent's handle is its card's to give.

import type { AgentCard } from "../contract/keel/index.ts";
import type { HeldUnder } from "../domain/state.ts";
import type { ChangeEntry, World } from "./world.ts";

/** Keel's public card of each agent asked for, by its id: null where Keel knows none by that id. */
export type Cards = ReadonlyMap<string, AgentCard | null>;

/** Where a run is on its agent's page. */
export const anchorOf = (runId: string): string => `run-${runId}`;

/** What an address calls an agent: its handle, or Keel's id for it where its card has none or is not yet read. */
export const addressOf = (cards: Cards, agentId: string): string =>
  cards.get(agentId)?.handle ?? agentId;

export type { HeldUnder } from "../domain/state.ts";

/** The agents that hold these changes, each once, in the order the changes name them: whose cards a page asks for. */
export function holdersOf(world: World, changeIds: readonly string[]): string[] {
  const holders = new Set<string>();
  for (const changeId of changeIds) {
    const change = world.changes.get(changeId);
    if (change !== undefined) holders.add(change.agentId);
  }
  return [...holders];
}

export function heldUnder(cards: Cards, change: ChangeEntry): HeldUnder {
  return {
    agent: addressOf(cards, change.agentId),
    ...(change.run === undefined
      ? {}
      : {
          run: {
            id: change.run.id,
            ...(change.run.label === undefined ? {} : { label: change.run.label }),
            anchor: anchorOf(change.run.id),
          },
        }),
  };
}
