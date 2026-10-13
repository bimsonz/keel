// A project's agents, and each one's runs in it, read off the folded world.
//
// Keel has no read that lists a project's agents or an agent's runs. Its log
// names both: the agent on every entry its command committed, the run where
// its token named one, and the run each change is held under. So the list and
// the page are folded from the entries the console already reads, all of them
// public, and a visitor is shown what a member is.
//
// The log names an agent by its id alone: its sign-up is in no project's log.
// What is shown of it is Keel's public card, which Keel reads anyone: its
// name, its handle, the kind it declared and the namespace it works in. Who
// stands behind it, the key it signed up with and that key's thumbprint are
// never here.

import type { AgentKind } from "../contract/keel/index.ts";
import type { ChangeState } from "../domain/state.ts";
import { type Cards, addressOf, anchorOf } from "./holder.ts";
import { type ChangeFilter, FILTER_OF_CHANGE, type Named, namesIn } from "./lists.ts";
import type { ChangeEntry, RunEntry, World } from "./world.ts";

export type { Cards } from "./holder.ts";

/** An agent as a page of this project names it. */
export interface AgentShown {
  id: string;
  /** What an address calls it: its handle, or Keel's id for it where its card has none or is not yet read. */
  name: string;
  /** Its name as its card has it, or as the log enrolled it. Absent where this reader has neither. */
  label?: string;
  handle?: string;
  /** The kind it declared, as its card has it. The declaration is the agent's own. */
  kind?: AgentKind;
  /** The handle of the namespace it works in, as its card has it. */
  namespace?: string;
}

export function agentShown(world: World, cards: Cards, agentId: string): AgentShown {
  const card = cards.get(agentId) ?? undefined;
  const label = card?.name ?? world.agents.get(agentId)?.name;
  return {
    id: agentId,
    name: addressOf(cards, agentId),
    ...(label === undefined ? {} : { label }),
    ...(card?.handle === undefined ? {} : { handle: card.handle }),
    ...(card?.kind === undefined ? {} : { kind: card.kind }),
    ...(card?.namespace === undefined ? {} : { namespace: card.namespace }),
  };
}

export interface AgentRow extends AgentShown {
  /** How many runs of its the log names here. */
  runs: number;
  /** The changes it holds that may still land: in flight, parked on a question, or bounced and to be revised. */
  holds: Named[];
  /** Every change it holds, wherever it got to. */
  changes: number;
  /** When it last wrote here. Absent where the log names it only as a change's holder. */
  lastAt?: string;
}

/** The filters a change is under once it can no longer land. */
const SETTLED: ReadonlySet<ChangeFilter> = new Set(["landed", "not-landed"]);

function held(world: World, agentId: string): ChangeEntry[] {
  return [...world.changes.values()].filter((change) => change.agentId === agentId);
}

/** Later first; an agent that has written nothing here goes last, and Keel's id settles the rest. */
function latest(a: { lastAt?: string; id: string }, b: { lastAt?: string; id: string }): number {
  if (a.lastAt !== b.lastAt) return (b.lastAt ?? "") < (a.lastAt ?? "") ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** The project's agents: one row for each the log names, the one that wrote last first. */
export function agentsOf(world: World, cards: Cards): AgentRow[] {
  const names = namesIn(world);
  return [...world.work.values()]
    .map((work): AgentRow => {
      const changes = held(world, work.agentId);
      return {
        ...agentShown(world, cards, work.agentId),
        runs: work.runs.size,
        holds: changes
          .filter((change) => !SETTLED.has(FILTER_OF_CHANGE[change.state]))
          .map((change) => ({
            id: change.id,
            label: change.label,
            name: names.changes.get(change.id) ?? change.id,
          })),
        changes: changes.length,
        ...(work.lastAt === undefined ? {} : { lastAt: work.lastAt }),
      };
    })
    .toSorted(latest);
}

export interface HeldChange extends Named {
  goal: string;
  state: ChangeState;
}

/** One run of an agent in this project, with the changes it holds. */
export interface RunSection {
  id: string;
  /** What the agent called the run. It is the agent's own word: Keel records it and vouches for none of it. */
  label?: string;
  /** Where on its agent's page the run is. */
  anchor: string;
  firstAt: string;
  lastAt: string;
  entries: number;
  changes: HeldChange[];
}

export interface AgentPageState {
  agent: AgentShown;
  /** Its runs here, the one that wrote last first. */
  runs: RunSection[];
  /** Its work under a token that named no run: how many entries, and the changes held that way. */
  unnamed?: { entries: number; changes: HeldChange[] };
  lastAt?: string;
}

/** The agent an address names in this project: by Keel's id for it, or by the handle its card has. */
export function agentNamed(world: World, cards: Cards, name: string): string | undefined {
  if (world.work.has(name)) return name;
  for (const work of world.work.values())
    if (cards.get(work.agentId)?.handle === name) return work.agentId;
  return undefined;
}

export function agentPageOf(world: World, cards: Cards, name: string): AgentPageState | null {
  const agentId = agentNamed(world, cards, name);
  const work = agentId === undefined ? undefined : world.work.get(agentId);
  if (agentId === undefined || work === undefined) return null;
  const names = namesIn(world);
  const changes = held(world, agentId);
  const under = (runId: string | undefined): HeldChange[] =>
    changes
      .filter((change) => change.run?.id === runId)
      .map((change) => ({
        id: change.id,
        label: change.label,
        name: names.changes.get(change.id) ?? change.id,
        goal: change.goal,
        state: change.state,
      }));
  const section = (run: RunEntry): RunSection => ({
    id: run.id,
    ...(run.label === undefined ? {} : { label: run.label }),
    anchor: anchorOf(run.id),
    firstAt: run.firstAt,
    lastAt: run.lastAt,
    entries: run.entries,
    changes: under(run.id),
  });
  const loose = under(undefined);
  return {
    agent: agentShown(world, cards, agentId),
    runs: [...work.runs.values()].map(section).toSorted(latest),
    ...(work.unnamed > 0 || loose.length > 0
      ? { unnamed: { entries: work.unnamed, changes: loose } }
      : {}),
    ...(work.lastAt === undefined ? {} : { lastAt: work.lastAt }),
  };
}

/** A handle, as Keel's contract has one. An agent's id is none: it has an underscore and capitals in it. */
const HANDLE = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Whether an address's name for an agent could be its handle, which only Keel can say whose it is. */
export function couldBeHandle(name: string): boolean {
  return HANDLE.test(name);
}
