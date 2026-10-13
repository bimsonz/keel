// What a project's own log says of its decisions, beside Keel's read of each.

import type { NextAction } from "../contract/events.ts";
import type { DecisionView } from "../contract/keel/index.ts";
import type { KeelDecisions } from "../source/types.ts";
import type { World } from "./world.ts";

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

/** As much of Keel's list as was asked for, and the cursor of the page after it where Keel named one. */
export interface DecisionsRead {
  items: DecisionView[];
  next?: string;
}

/**
 * The first `pages` pages of Keel's list, each asked for with the cursor the page before it gave. The list ends
 * at the page that names no cursor, and nothing is asked past it.
 */
export async function readDecisions(
  source: KeelDecisions,
  subject: string | undefined,
  pages: number,
  signal?: AbortSignal,
): Promise<DecisionsRead> {
  const items: DecisionView[] = [];
  let cursor: string | undefined;
  for (let asked = 0; asked < Math.max(pages, 1); asked += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a page names the next one
    const page = await source.listDecisions(
      {
        ...(subject === undefined ? {} : { subject }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      signal,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === undefined || cursor === "") return { items };
  }
  return { items, ...(cursor === undefined ? {} : { next: cursor }) };
}

/** A line of a project's list of decisions: Keel's own row, and what this project's log calls the conflict it names. */
export interface DecisionRow {
  id: string;
  label: string;
  summary: string;
  decidedAt: string;
  state: DecisionView["state"];
  subject?: string;
  /** The conflict it ruled. Its label is the log's, and empty where the log this reader is read names none. */
  conflict?: Called;
}

/** A thing Keel's read names by its id, with what the project's log calls it: its label, or its id where it has none. */
export interface Called {
  id: string;
  label: string;
}

/** A page of the list, in the order Keel gave it: nothing is sorted or left out here. */
export function decisionRowsOf(items: readonly DecisionView[], world: World): DecisionRow[] {
  return items.map((view) => ({
    id: view.id,
    label: view.label,
    summary: view.summary,
    decidedAt: view.decidedAt,
    state: view.state,
    ...(view.subject === undefined ? {} : { subject: view.subject }),
    ...(view.conflictId === undefined
      ? {}
      : {
          conflict: {
            id: view.conflictId,
            label: world.conflicts.get(view.conflictId)?.label ?? "",
          },
        }),
  }));
}

/**
 * What a decision's guard does now. `blocks`: the decision stands and a guard holds it, so a change that fails
 * the guard is bounced whatever the project's policy for the predicate. `unguarded`: it stands and Keel names
 * no guard that holds it, as where the ruling upheld the effect. `ended`: it was superseded or overruled, and a
 * guard blocks for a decision that stands and for no other.
 */
export type Standing = "blocks" | "unguarded" | "ended";

export function standingOf(view: Pick<DecisionView, "state" | "guards">): Standing {
  if (view.state !== "active") return "ended";
  return view.guards.length > 0 ? "blocks" : "unguarded";
}

/** One decision's page: Keel's read of it, and what the project's log calls each thing that read names. */
export interface DecisionDetail {
  id: string;
  label: string;
  summary: string;
  option: string;
  decidedAt: string;
  state: DecisionView["state"];
  standing: Standing;
  subject?: string;
  conflict?: Called;
  /** What the ruling upheld, in the propositions Keel's row holds. Empty where it favoured neither side. */
  holds: DecisionView["holds"];
  /** The changes the ruling went against. */
  against: Called[];
  /** The guards that hold it, each with the conflict whose proof it was admitted from where the log says. */
  guards: (Called & { conflictId?: string })[];
  /** The changes Keel bounced citing it, as the project's log has them, oldest first. */
  bounced: Called[];
  /** The question it answered: named only to a reader Keel reads the project's questions to. */
  question?: Called;
}

/**
 * `publicOnly` is whether this reader is read the public part of the project's log alone. Keel reads a
 * project's questions to its members, so nobody else is shown that a decision answered one.
 */
export function decisionDetailOf(
  view: DecisionView,
  world: World,
  publicOnly: boolean,
): DecisionDetail {
  const change = (id: string): Called => ({ id, label: world.changes.get(id)?.label ?? id });
  const conflict = decisionRowsOf([view], world)[0]?.conflict;
  return {
    id: view.id,
    label: view.label,
    summary: view.summary,
    option: view.option,
    decidedAt: view.decidedAt,
    state: view.state,
    standing: standingOf(view),
    ...(view.subject === undefined ? {} : { subject: view.subject }),
    ...(conflict === undefined ? {} : { conflict }),
    holds: view.holds,
    against: (view.against ?? []).map(change),
    guards: view.guards.map((id) => {
      const guard = world.guards.get(id);
      return {
        id,
        label: guard?.label ?? id,
        ...(guard === undefined ? {} : { conflictId: guard.conflictId }),
      };
    }),
    bounced: (world.citing.get(view.id) ?? []).map(change),
    ...(publicOnly
      ? {}
      : {
          question: {
            id: view.escalationId,
            label: world.escalations.get(view.escalationId)?.label ?? "",
          },
        }),
  };
}

/**
 * What the project's log has said that Keel's read of a decision is joined from: each decision and whether it
 * stands, the resolution that names one and whom it went against, each guard and whether it is retired, and
 * who was bounced citing one. A page that shows Keel's read asks again when this changes, and at no other time.
 */
export function turnsOf(world: World): string {
  return [
    ...[...world.decisions.values()].map((decision) => `d:${decision.id}:${decision.state}`),
    ...[...world.conflicts.values()].flatMap((conflict) =>
      conflict.decisionId === undefined
        ? []
        : [`c:${conflict.id}:${conflict.decisionId}:${(conflict.against ?? []).join(",")}`],
    ),
    ...[...world.guards.values()].map((guard) => `g:${guard.id}:${guard.state}`),
    ...[...world.citing].map(([decision, changes]) => `b:${decision}:${changes.join(",")}`),
  ].join(" ");
}
