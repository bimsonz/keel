// The name a project's owner is shown by, where Keel gives one: an agent's namespace by the name on the agent's
// card, as GitHub heads a profile with a person's name above their login. Keel's list of projects names each
// owner by handle and kind only, so the card is read by the namespace's id, which for an agent is its own.
// A person's and an org's namespace keep their handle: Keel serves no other name for them to a reader of a list.

import type { ProjectView } from "../contract/keel/index.ts";
import type { KeelAgents, KeelDirectory } from "../source/types.ts";

/**
 * The card's name of each agent that owns one of `projects`, by the namespace's handle. An agent whose card
 * cannot be read, or names it by its handle, is left out: its handle is what it is shown by.
 */
export async function agentNames(
  projects: readonly ProjectView[],
  directory: Pick<KeelDirectory, "findNamespace">,
  agents: KeelAgents,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const handles = new Set(
    projects
      .filter((project) => project.namespace.kind === "agent")
      .map((project) => project.namespace.handle),
  );
  const named = await Promise.all(
    [...handles].map(async (handle): Promise<[string, string] | null> => {
      try {
        const namespace = await directory.findNamespace(handle, signal);
        if (namespace?.kind !== "agent") return null;
        const card = await agents.findAgent(namespace.id, signal);
        return card === null || card.name === handle ? null : [handle, card.name];
      } catch {
        return null;
      }
    }),
  );
  return new Map(named.filter((pair) => pair !== null));
}
