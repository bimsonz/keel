// Who holds a change, and under which run: what a change's row and its page
// say of it, and where they link to. The log names the holder by its id and
// the run by Keel's id for it; the agent's handle is its card's to give, and
// its page is its account's, as a code host's author is their profile's.

import type { AgentCard } from "../contract/keel/index.ts";
import type { HeldUnder } from "../domain/state.ts";
import type { ChangeEntry, World } from "./world.ts";

/** Keel's public card of each agent asked for, by its id: null where Keel knows none by that id. */
export type Cards = ReadonlyMap<string, AgentCard | null>;

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

/**
 * The agents that hold these changes in the worlds a page draws: the log's, and Keel's snapshot of its head while
 * the list of changes is drawn from it, so a list drawn early names its holders too. Each once.
 */
export function holdersShown(
  shown: { readonly world: World; readonly seeded: World | null },
  changeIds: readonly string[],
): string[] {
  const seeded = shown.seeded === null ? [] : holdersOf(shown.seeded, changeIds);
  return [...new Set([...holdersOf(shown.world, changeIds), ...seeded])];
}

export function heldUnder(cards: Cards, change: ChangeEntry): HeldUnder {
  const handle = cards.get(change.agentId)?.handle;
  return {
    ...(handle === undefined ? {} : { handle }),
    ...(change.run === undefined
      ? {}
      : {
          run: {
            id: change.run.id,
            ...(change.run.label === undefined ? {} : { label: change.run.label }),
          },
        }),
  };
}
