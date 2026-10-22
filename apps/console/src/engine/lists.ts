// The three lists a project has: its changes, its conflicts and its
// escalations. Each is read off the folded world, newest first, filed under
// one filter, a page at a time, with what each row is tied to named so the
// page can link to it.
//
// An address calls a thing by the short label Keel gave it (#7 is `7`, C-1 is
// `C-1`). Where two things would be called the same, each is called by its id.
// A name always finds the one thing it was given to.
//
// A change is open while it may still land: in flight, parked on a question,
// or bounced and waiting for its agent to revise it.

import type { ParkReason } from "../contract/keel/index.ts";
import type { EscalationCategory } from "../contract/events.ts";
import type { ChangeState, ConflictKind, ConflictState, ShownClass } from "../domain/state.ts";
import { agentName } from "./audience.ts";
import { type Cards, type HeldUnder, heldUnder } from "./holder.ts";
import { subjectOf } from "./lanes.ts";
import {
  authorAgentOf,
  authorEntryOf,
  type ChangeEntry,
  type ConflictEntry,
  type DecisionEntry,
  type EscalationEntry,
  type World,
} from "./world.ts";

/** How many rows a list shows before it is asked for more. */
export const PAGE = 50;

/**
 * A code host's pull request list: open and closed, then the open ones parked on a ruling or bounced back to
 * their agent, and the closed ones that landed.
 */
export type ChangeFilter = "open" | "closed" | "landed" | "parked" | "bounced" | "proposals";
export type ConflictFilter = "open" | "settled";
/** Closed: answered by a person, or withdrawn before anyone answered. */
export type EscalationFilter = "open" | "closed";

/** The filters each state of a change is filed under: open or closed, and where it is one, the narrower one. */
export const FILTERS_OF_CHANGE: Record<ChangeState, readonly ChangeFilter[]> = {
  declared: ["open"],
  working: ["open"],
  submitted: ["open"],
  deriving: ["open"],
  drifted: ["open"],
  verifying: ["open"],
  queued: ["open"],
  integrating: ["open"],
  parked: ["open", "parked"],
  // Refused by a verdict, and not the end of it: its agent may revise it.
  bounced: ["open", "bounced"],
  landed: ["closed", "landed"],
  withdrawn: ["closed"],
  superseded: ["closed"],
};

const FILTER_OF_CONFLICT: Record<ConflictState, ConflictFilter> = {
  suspected: "open",
  probing: "open",
  proven: "open",
  escalated: "open",
  resolved: "settled",
  dismissed: "settled",
};

const FILTER_OF_ESCALATION: Record<EscalationEntry["state"], EscalationFilter> = {
  open: "open",
  ruled: "closed",
  withdrawn: "closed",
};

/** Something a row is tied to: what to call it on screen, and in an address. */
export interface Named {
  id: string;
  label: string;
  name: string;
}

export interface ChangeRow extends Named {
  goal: string;
  state: ChangeState;
  /** Why Keel parked it, where it is parked. */
  parkedOn?: ParkReason;
  agent: string;
  agentClass: ShownClass;
  /** Its holder's page in this project, and the run it is held under. */
  held: HeldUnder;
  /** The key of the subject it is about, when it has said or shown one. */
  subject?: string;
  declaredAt: string;
  unverified: boolean;
  /** The conflicts it is party to that are still open. */
  conflicts: (Named & { state: ConflictState })[];
  escalation?: Named & { open: boolean };
}

export interface ConflictRow extends Named {
  summary: string;
  state: ConflictState;
  kind: ConflictKind;
  subject?: string;
  openedAt: string;
  parties: Named[];
  probe?: { label: string; state: "calibrating" | "admitted" | "discarded" | "retired" };
  escalation?: Named & { open: boolean };
  guard?: { label: string };
  decision?: { id: string; label: string };
}

export interface EscalationRow extends Named {
  question: string;
  state: EscalationEntry["state"];
  category: EscalationCategory;
  subject?: string;
  raisedAt: string;
  conflict?: Named;
  /** How many changes are parked on it now. */
  parked: number;
  /** The option chosen, in its own words, once someone has ruled. */
  ruled?: string;
  decision?: { id: string; label: string };
}

export interface Listing<Row, Filter extends string> {
  filter: Filter;
  /** How many there are under each filter, whichever is shown. */
  counts: Record<Filter, number>;
  rows: Row[];
  /** How many there are under the filter shown. */
  total: number;
  /** True while there are rows under this filter that are not shown. */
  more: boolean;
}

type Labelled = { id: string; label: string };

/**
 * What an address calls each entry: its label, without the mark Keel's labels of its kind begin with (`#` for a
 * change), where that calls nothing else; or else its id. No two entries are called the same, and none is called
 * what another's id is.
 */
function namesOf(entries: ReadonlyMap<string, Labelled>, strip = ""): Map<string, string> {
  const short = (entry: Labelled): string =>
    strip !== "" && entry.label.startsWith(strip) ? entry.label.slice(strip.length) : entry.label;
  const called = new Map<string, number>();
  for (const entry of entries.values())
    called.set(short(entry), (called.get(short(entry)) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const entry of entries.values()) {
    const name = short(entry);
    names.set(
      entry.id,
      name !== "" && called.get(name) === 1 && !entries.has(name) ? name : entry.id,
    );
  }
  return names;
}

/** The entry an address calls `name`: the one with that id, or the one `namesOf` gave that name to. */
function named<Entry extends Labelled>(
  entries: ReadonlyMap<string, Entry>,
  name: string,
  strip = "",
): Entry | undefined {
  const byId = entries.get(name);
  if (byId !== undefined) return byId;
  const names = namesOf(entries, strip);
  return [...entries.values()].find((entry) => names.get(entry.id) === name);
}

export const changeNamed = (world: World, name: string): ChangeEntry | undefined =>
  named(world.changes, name, "#");
export const conflictNamed = (world: World, name: string): ConflictEntry | undefined =>
  named(world.conflicts, name);
export const escalationNamed = (world: World, name: string): EscalationEntry | undefined =>
  named(world.escalations, name);
export const decisionNamed = (world: World, name: string): DecisionEntry | undefined =>
  named(world.decisions, name);

/** What an address calls every change, conflict, escalation and decision, by id: read once for a whole list, or a whole page. */
export interface Names {
  changes: Map<string, string>;
  conflicts: Map<string, string>;
  escalations: Map<string, string>;
  decisions: Map<string, string>;
}

export function namesIn(world: World): Names {
  return {
    changes: namesOf(world.changes, "#"),
    conflicts: namesOf(world.conflicts),
    escalations: namesOf(world.escalations),
    decisions: namesOf(world.decisions),
  };
}

function tied(entry: Labelled | undefined, names: Map<string, string>): Named | undefined {
  return entry === undefined
    ? undefined
    : { id: entry.id, label: entry.label, name: names.get(entry.id) ?? entry.id };
}

function question(
  world: World,
  id: string | undefined,
  names: Names,
): (Named & { open: boolean }) | undefined {
  const escalation = id === undefined ? undefined : world.escalations.get(id);
  const as = tied(escalation, names.escalations);
  return escalation === undefined || as === undefined
    ? undefined
    : { ...as, open: escalation.state === "open" };
}

/** Newest first, filed, and cut to what is shown. */
function listing<Entry, Row, Filter extends string>(
  entries: Iterable<Entry>,
  filters: readonly Filter[],
  filtersOf: (entry: Entry) => readonly Filter[],
  filter: Filter,
  shown: number,
  row: (entry: Entry) => Row,
): Listing<Row, Filter> {
  const counts = new Map<Filter, number>(filters.map((each) => [each, 0]));
  const under: Entry[] = [];
  for (const entry of entries) {
    const filed = filtersOf(entry);
    for (const each of filed) counts.set(each, (counts.get(each) ?? 0) + 1);
    if (filed.includes(filter)) under.push(entry);
  }
  const newest = under.toReversed();
  // `counts` holds every filter, so it is the whole record.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built from `filters`, which is every key
  const whole = Object.fromEntries(counts) as Record<Filter, number>;
  return {
    filter,
    counts: whole,
    rows: newest.slice(0, shown).map(row),
    total: newest.length,
    more: newest.length > shown,
  };
}

/**
 * The filters a change is filed under. A parked change waits on a person only where Keel parked it for a ruling:
 * one parked because its agent's lease lapsed waits on its agent, and is open and nothing narrower, unless Keel
 * had bounced it. Bounced means the same here as in the pipeline and Mission Control: from Keel's bounce until
 * the change moves on, submitted again or adopted, whether or not its agent is still there to revise it.
 */
export function filtersOfChange(
  change: Pick<ChangeEntry, "state" | "parkedOn" | "parkedFrom" | "proposal">,
): readonly ChangeFilter[] {
  const filters =
    change.state === "parked" && change.parkedOn !== "awaiting-ruling"
      ? change.parkedFrom === "bounced"
        ? FILTERS_OF_CHANGE.bounced
        : (["open"] as const)
      : FILTERS_OF_CHANGE[change.state];
  // An open proposal from a fork is one of the project's proposals too, as a code host lists a fork's pull requests.
  return change.proposal !== undefined && filters.includes("open")
    ? [...filters, "proposals"]
    : filters;
}

/** Whether a change counts as bounced: Keel bounced it, and it has not moved on since. */
export function isBounced(change: Pick<ChangeEntry, "state" | "parkedOn" | "parkedFrom">): boolean {
  return filtersOfChange(change).includes("bounced");
}

/** Whether a change waits on a person's ruling: parked, and for that. */
export function waitsOnARuling(
  change: Pick<ChangeEntry, "state" | "parkedOn" | "parkedFrom">,
): boolean {
  return filtersOfChange(change).includes("parked");
}

export const CHANGE_FILTERS = [
  "open",
  "closed",
  "landed",
  "parked",
  "bounced",
  "proposals",
] as const satisfies readonly ChangeFilter[];
export const CONFLICT_FILTERS = ["open", "settled"] as const satisfies readonly ConflictFilter[];
export const ESCALATION_FILTERS = ["open", "closed"] as const satisfies readonly EscalationFilter[];

export function changesOf(
  world: World,
  filter: ChangeFilter,
  shown = PAGE,
  cards: Cards = new Map(),
): Listing<ChangeRow, ChangeFilter> {
  const names = namesIn(world);
  return listing(
    world.changes.values(),
    CHANGE_FILTERS,
    (change) => filtersOfChange(change),
    filter,
    shown,
    (change): ChangeRow => {
      const by = authorEntryOf(world, change);
      const author = authorAgentOf(change);
      const subject = subjectOf(change);
      const escalation = question(world, change.escalationId, names);
      return {
        id: change.id,
        label: change.label,
        name: names.changes.get(change.id) ?? change.id,
        goal: change.goal,
        state: change.state,
        // An agent the reader has no name for is one all the same.
        agent:
          agentName(by, author === undefined ? undefined : cards.get(author)) ??
          (author === undefined && change.proposal !== undefined ? "a person" : "an agent"),
        agentClass: by?.class ?? "unnamed",
        held: heldUnder(cards, change),
        ...(subject === undefined ? {} : { subject }),
        declaredAt: change.declaredAt,
        unverified: change.unverified,
        conflicts: change.conflictIds.flatMap((id) => {
          const conflict = world.conflicts.get(id);
          const as = tied(conflict, names.conflicts);
          return conflict !== undefined &&
            as !== undefined &&
            FILTER_OF_CONFLICT[conflict.state] === "open"
            ? { ...as, state: conflict.state }
            : [];
        }),
        ...(escalation === undefined ? {} : { escalation }),
        ...(change.state === "parked" && change.parkedOn !== undefined
          ? { parkedOn: change.parkedOn }
          : {}),
      };
    },
  );
}

export function conflictsOf(
  world: World,
  filter: ConflictFilter,
  shown = PAGE,
): Listing<ConflictRow, ConflictFilter> {
  const names = namesIn(world);
  return listing(
    world.conflicts.values(),
    CONFLICT_FILTERS,
    (conflict) => [FILTER_OF_CONFLICT[conflict.state]],
    filter,
    shown,
    (conflict): ConflictRow => {
      const subject = conflict.subjectKey;
      const probe = conflict.probeId === undefined ? undefined : world.probes.get(conflict.probeId);
      const guard = conflict.guardId === undefined ? undefined : world.guards.get(conflict.guardId);
      const decision =
        conflict.decisionId === undefined ? undefined : world.decisions.get(conflict.decisionId);
      const escalation = question(world, conflict.escalationId, names);
      return {
        id: conflict.id,
        label: conflict.label,
        name: names.conflicts.get(conflict.id) ?? conflict.id,
        summary: conflict.title,
        state: conflict.state,
        kind: conflict.kind,
        ...(subject === undefined ? {} : { subject }),
        openedAt: conflict.openedAt,
        parties: conflict.parties.flatMap((id) => tied(world.changes.get(id), names.changes) ?? []),
        ...(probe === undefined ? {} : { probe: { label: probe.label, state: probe.state } }),
        ...(escalation === undefined ? {} : { escalation }),
        ...(guard === undefined ? {} : { guard: { label: guard.label } }),
        ...(decision === undefined ? {} : { decision: { id: decision.id, label: decision.label } }),
      };
    },
  );
}

export function escalationsOf(
  world: World,
  filter: EscalationFilter,
  shown = PAGE,
): Listing<EscalationRow, EscalationFilter> {
  const names = namesIn(world);
  const parked = new Map<string, number>();
  for (const change of world.changes.values()) {
    if (change.state === "parked" && change.escalationId !== undefined)
      parked.set(change.escalationId, (parked.get(change.escalationId) ?? 0) + 1);
  }
  return listing(
    world.escalations.values(),
    ESCALATION_FILTERS,
    (escalation) => [FILTER_OF_ESCALATION[escalation.state]],
    filter,
    shown,
    (escalation): EscalationRow => {
      const conflict =
        escalation.about.kind === "conflict" ? world.conflicts.get(escalation.about.id) : undefined;
      const subject =
        conflict?.subjectId === undefined ? undefined : world.subjects.get(conflict.subjectId)?.key;
      const about = tied(conflict, names.conflicts);
      const chosen = escalation.options.find((option) => option.id === escalation.ruling?.option);
      const decision =
        conflict?.decisionId === undefined ? undefined : world.decisions.get(conflict.decisionId);
      return {
        id: escalation.id,
        label: escalation.label,
        name: names.escalations.get(escalation.id) ?? escalation.id,
        question: escalation.question,
        state: escalation.state,
        category: escalation.category,
        ...(subject === undefined ? {} : { subject }),
        raisedAt: escalation.raisedAt,
        ...(about === undefined ? {} : { conflict: about }),
        parked: parked.get(escalation.id) ?? 0,
        ...(escalation.ruling === undefined
          ? {}
          : { ruled: chosen?.label ?? escalation.ruling.option }),
        ...(decision === undefined ? {} : { decision: { id: decision.id, label: decision.label } }),
      };
    },
  );
}

/** What each tab counts: what is still open. */
export function openCounts(world: World): {
  changes: number;
  conflicts: number;
  escalations: number;
} {
  let changes = 0;
  for (const change of world.changes.values())
    if (FILTERS_OF_CHANGE[change.state].includes("open")) changes += 1;
  let conflicts = 0;
  for (const conflict of world.conflicts.values())
    if (FILTER_OF_CONFLICT[conflict.state] === "open") conflicts += 1;
  let escalations = 0;
  for (const escalation of world.escalations.values())
    if (escalation.state === "open") escalations += 1;
  return { changes, conflicts, escalations };
}
