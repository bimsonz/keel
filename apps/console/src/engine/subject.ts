// One subject, read off the folded world: what is relied on there, what
// guards it, what has been decided about it, and the changes and conflicts
// on it right now. This is what Mission Control opens beside the graph when a subject is selected.

import { waitsOnARuling } from "./lists.ts";
import type {
  ChangeState,
  ConflictKind,
  ConflictState,
  Doubt,
  ShownClass,
} from "../domain/state.ts";
import { agentName } from "./audience.ts";
import { doubtsOf } from "./doubts.ts";
import type { Cards } from "./holder.ts";
import { type Tone, glossOf, subjectOf } from "./lanes.ts";
import { authorAgentOf, authorEntryOf, type World } from "./world.ts";

export interface SubjectDetail {
  id: string;
  key: string;
  gloss: string;
  tone: Tone;
  /** Each distinct premise held here, most relied-on first. */
  premises: {
    predicate: string;
    relation: string;
    value: string;
    /** Changes still in flight that hold it. */
    live: number;
    /** Changes that held it and have landed. */
    landed: number;
  }[];
  guards: {
    id: string;
    label: string;
    state: "admitted" | "retired";
    admittedAt: string;
    probe: string;
    conflict: string;
  }[];
  decisions: {
    id: string;
    label: string;
    chosen: string;
    decidedAt: string;
    state: "active" | "superseded" | "overruled";
  }[];
  /** Newest first. */
  conflicts: {
    id: string;
    label: string;
    kind: ConflictKind;
    state: ConflictState;
    summary: string;
    openedAt: string;
  }[];
  changes: {
    /** Changes on this subject that are still going. */
    total: number;
    byState: [ChangeState, number][];
    /** The ones to name: parties to an open conflict, parked or bounced, REAL sessions; then the most recent. */
    listed: {
      id: string;
      label: string;
      goal: string;
      state: ChangeState;
      agent: string;
      agentClass: ShownClass;
      /** Its premises on this subject Keel put in doubt. */
      /** Parked for a person's ruling, not for its agent's lapsed lease. */
      ruling: boolean;
      doubts: Doubt[];
    }[];
  };
  tenets: number;
}

const OVER = new Set<ChangeState>(["landed", "withdrawn", "superseded"]);
const SETTLED = new Set<ConflictState>(["resolved", "dismissed"]);
const LISTED = 8;

/** `subject` is a subject's id or its key. */
export function subjectDetailOf(
  world: World,
  subject: string,
  cards: Cards = new Map(),
): SubjectDetail | null {
  const entry = world.subjects.get(subject) ?? world.subjectByKey(subject);
  if (entry === undefined) return null;

  const premises = new Map<string, SubjectDetail["premises"][number]>();
  for (const [changeId, premise] of entry.premises) {
    const says = `${premise.predicate} ${premise.relation} ${String(premise.value)}`;
    const group = premises.get(says) ?? {
      predicate: premise.predicate,
      relation: premise.relation,
      value: String(premise.value),
      live: 0,
      landed: 0,
    };
    const state = world.changes.get(changeId)?.state;
    if (state === "landed") group.landed += 1;
    else if (state !== undefined && !OVER.has(state)) group.live += 1;
    premises.set(says, group);
  }

  const conflicts = [...world.conflicts.values()].filter(
    (conflict) => conflict.subjectId === entry.id,
  );
  const open = conflicts.filter((conflict) => !SETTLED.has(conflict.state));
  const contested = new Set(open.flatMap((conflict) => conflict.parties));
  const guards = entry.guardIds.flatMap((id) => world.guards.get(id) ?? []);
  const going = [...world.changes.values()].filter(
    (change) => subjectOf(change) === entry.key && !OVER.has(change.state),
  );
  const tally = new Map<ChangeState, number>();
  for (const change of going) tally.set(change.state, (tally.get(change.state) ?? 0) + 1);
  const weight = (change: (typeof going)[number]): number =>
    contested.has(change.id)
      ? 0
      : change.state === "parked" || change.state === "bounced"
        ? 1
        : authorEntryOf(world, change)?.class === "real"
          ? 2
          : 3;

  return {
    id: entry.id,
    key: entry.key,
    gloss: glossOf(entry),
    // A person is asked only while an escalated conflict's question is open; an escalated one is proven either way.
    tone: open.some(
      (conflict) =>
        conflict.state === "escalated" &&
        conflict.escalationId !== undefined &&
        world.escalations.get(conflict.escalationId)?.state === "open",
    )
      ? "person"
      : open.some((conflict) => conflict.state === "proven" || conflict.state === "escalated")
        ? "proven"
        : open.length > 0
          ? "suspected"
          : guards.some((guard) => guard.state === "admitted")
            ? "pass"
            : "plain",
    premises: [...premises.values()]
      .filter((group) => group.live + group.landed > 0)
      .toSorted((a, b) => b.live - a.live || b.landed - a.landed),
    guards: guards.map((guard) => ({
      id: guard.id,
      label: guard.label,
      state: guard.state,
      admittedAt: guard.admittedAt,
      probe: world.probes.get(guard.probeId)?.label ?? "",
      conflict: world.conflicts.get(guard.conflictId)?.label ?? "",
    })),
    decisions: entry.decisionIds.flatMap((id) => {
      const decision = world.decisions.get(id);
      return decision === undefined
        ? []
        : [
            {
              id,
              label: decision.label,
              chosen: decision.chosen,
              decidedAt: decision.decidedAt,
              state: decision.state,
            },
          ];
    }),
    conflicts: conflicts
      .map((conflict) => ({
        id: conflict.id,
        label: conflict.label,
        kind: conflict.kind,
        state: conflict.state,
        summary: conflict.title,
        openedAt: conflict.openedAt,
      }))
      .toReversed(),
    changes: {
      total: going.length,
      byState: [...tally].toSorted((a, b) => b[1] - a[1]),
      // Stable: among equals, the most recently declared first.
      listed: going
        .toReversed()
        .toSorted((a, b) => weight(a) - weight(b))
        .slice(0, LISTED)
        .map((change) => {
          const by = authorEntryOf(world, change);
          const author = authorAgentOf(change);
          return {
            id: change.id,
            label: change.label,
            goal: change.goal,
            state: change.state,
            ruling: waitsOnARuling(change),
            agent:
              agentName(by, author === undefined ? undefined : cards.get(author)) ?? "an agent",
            agentClass: by?.class ?? "unnamed",
            doubts: doubtsOf(world, change, entry.id),
          };
        }),
    },
    tenets: entry.tenetIds.length,
  };
}
