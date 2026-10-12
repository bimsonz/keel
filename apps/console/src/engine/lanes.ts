// Mission Control's lanes: the things that exist in Keel right now and how
// they relate, read off the folded world. There is one lane to a subject, and
// in it a node stands for one real entity, and is there only while that
// entity matters: a change appears when it is declared and leaves shortly
// after it lands; a conflict brings its probe, its question and its guard
// with it. What evidence earned (guards, decisions) stays.
//
// Lanes are in order of what most needs looking at: what a person is being
// asked about, then what is contested, then where a real session is working,
// then the busiest. Those of the first three kinds are drawn in full. The
// rest are one line each until a reader opens one. With a handful of agents
// every lane is open and every change is drawn. With a swarm, ordinary
// changes are counted beside their subject and only the notable ones are
// drawn: REAL sessions, parties to a conflict, anything parked or bounced.
//
// Nothing is left out for good. A lane not shown is counted, and shown when
// more are asked for.

import type {
  AgentClass,
  ChangeState,
  ConflictKind,
  ConflictState,
  Outcome,
  Pending,
  World as WorldId,
} from "../domain/state.ts";
import { sidesOf } from "./sides.ts";
import type { ChangeEntry, ConflictEntry, EscalationEntry, SubjectEntry, World } from "./world.ts";

export type Tone = "plain" | "suspected" | "proven" | "person" | "pass";

export type GraphNode = { id: string } & (
  | { kind: "agent"; label: string; agentClass: AgentClass; harness: string }
  | {
      kind: "change";
      changeId: string;
      label: string;
      goal: string;
      state: ChangeState;
      revision: number;
      /** What ties it to its subject, in the fewest true words: what it relies on there, or what it alters. `derived`: Keel read it off the diff. */
      holds?: { text: string; derived: boolean };
      /** Where it is in integration, when it is: "Lane 1", "batch L1·3". */
      where?: string;
      /** True where its verdict or its landing was not verified. */
      unverified?: boolean;
    }
  /** The changes on a subject that are not drawn one by one, counted by state. */
  | {
      kind: "stack";
      subjectKey: string;
      count: number;
      /** How many of the subject's changes are drawn beside it. */ beside: number;
      byState: [ChangeState, number][];
    }
  | {
      kind: "subject";
      key: string;
      gloss: string;
      premises: number;
      guards: number;
      decisions: number;
      tone: Tone;
    }
  | {
      kind: "conflict";
      conflictId: string;
      label: string;
      conflictKind: ConflictKind;
      state: ConflictState;
      summary: string;
      costUsd?: number;
    }
  | {
      kind: "probe";
      conflictId: string;
      label: string;
      state: "calibrating" | "admitted" | "discarded";
      /** Three runs per world, in the order they arrive. */
      runs: [WorldId, (Outcome | Pending)[]][];
    }
  /**
   * `standing` is what holds until someone answers: the question's default option, by Keel's own name for it.
   * `decision` is what the answer was recorded as, once there is one.
   */
  | {
      kind: "escalation";
      escalationId: string;
      label: string;
      question: string;
      standing: string;
      state: "open" | "ruled" | "withdrawn";
      decision?: { label: string; chosen: string };
    }
  | { kind: "decision"; label: string; chosen: string }
  | { kind: "guard"; label: string; state: "admitted" | "retired" }
);

export type GraphNodeKind = GraphNode["kind"];

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  tone: Tone;
  /** Derived by Keel, not declared by the agent. */
  derived?: boolean;
}

/** The key of the one lane that is no subject's. No subject's key is empty. */
export const NO_SUBJECT = "";

export interface Lane {
  /** The subject's key: what the lane is called, and how it is opened and closed. */
  key: string;
  /**
   * The subject the lane is for. Absent for the one lane of changes that have said nothing about a subject
   * yet, or about one Keel has not minted: an agent stands beside its change there, and nothing further along.
   */
  subject?: Extract<GraphNode, { kind: "subject" }>;
  /** Drawn in full, or one line. */
  open: boolean;
  /** Changes on this subject that are still going. */
  changes: number;
  byState: [ChangeState, number][];
  /** Conflicts on this subject that are not settled. */
  conflicts: number;
  /** Empty while the lane is one line. */
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Lanes {
  /** Everyone enrolled, by class. A swarm is counted here, and is not a node. */
  agents: Record<AgentClass, number>;
  /** Changes that are open: in flight, parked or bounced, on any subject or none yet. */
  changes: number;
  /** A lane to each subject shown, in their order, and last the lane of changes on no subject, where there are any. */
  lanes: Lane[];
  /** What is on the lanes not shown: asked for, they are shown. */
  more: { lanes: number; changes: number; conflicts: number };
}

export interface LaneOptions {
  /** Lanes a reader has opened, and lanes a reader has closed, by subject key. What a reader chose stands. */
  opened?: ReadonlySet<string>;
  closed?: ReadonlySet<string>;
  /** How many lanes to show. */
  shown?: number;
  /** The subject a reader has open beside the graph. Its lane is shown, and open, however far down it comes. */
  pinned?: string;
}

/** How many lanes are shown before more are asked for. */
export const LANES = 20;

/** How long something finished stays in its lane before it leaves, in simulated ms. */
const LINGER_MS = 12_000;
/** Above this many live changes, ordinary ones are counted instead of drawn, and quiet lanes are one line. */
const DRAW_ALL_UP_TO = 14;

const OVER = new Set<ChangeState>(["landed", "withdrawn", "superseded"]);
const SETTLED = new Set<ConflictState>(["resolved", "dismissed"]);
const WORLDS: WorldId[] = ["trunk", "A-noop", "A", "B", "AB"];

/** The subject a change is about: the one it relies on, or else the one its first effect is on. */
export function subjectOf(change: ChangeEntry): string | undefined {
  return change.premises[0]?.subject ?? change.effects[0]?.proposition.subject ?? undefined;
}

function words(value: string): string {
  return value.replaceAll("-", " ");
}

/** What ties a change to its subject. `altering`: an open conflict names it as the side that alters. */
function tie(
  change: ChangeEntry,
  subjectKey: string,
  altering: boolean,
): { holds?: { text: string; derived: boolean }; tone: Tone } {
  const effects = change.effects.filter((effect) => effect.proposition.subject === subjectKey);
  // Where an extractor and Clef both derived it, the extractor's is the fact.
  const effect = effects.find((candidate) => candidate.method === "extractor") ?? effects[0];
  if (effect !== undefined) {
    return {
      holds: {
        text: `alters: ${words(effect.proposition.relation)} ${String(effect.proposition.value)}`,
        derived: !effect.declared,
      },
      tone: altering ? "proven" : "plain",
    };
  }
  const premise = change.premises.find((candidate) => candidate.subject === subjectKey);
  if (premise === undefined) return { tone: "plain" };
  return {
    holds: {
      text: `relies on: ${words(premise.relation)} ${String(premise.value)}`,
      derived: false,
    },
    tone: "plain",
  };
}

function where(world: World, change: ChangeEntry): string | undefined {
  if (change.state === "integrating" && change.batchId !== undefined)
    return `batch ${world.batches.get(change.batchId)?.label ?? ""}`;
  if (change.state === "queued" && change.laneId !== undefined)
    return change.laneId.replace("lane-", "Lane ");
  return undefined;
}

function tally(changes: ChangeEntry[]): [ChangeState, number][] {
  const counts = new Map<ChangeState, number>();
  for (const change of changes) counts.set(change.state, (counts.get(change.state) ?? 0) + 1);
  return [...counts].toSorted((a, b) => b[1] - a[1]);
}

/** A subject with something on it, and where it comes in the order. */
interface Ranked {
  subject: SubjectEntry;
  /** Every conflict on it still in view: the unsettled, and the just settled. */
  here: ConflictEntry[];
  open: ConflictEntry[];
  changes: ChangeEntry[];
  /** 0: a person is being asked. 1: contested. 2: a real session is working here. 3: busy, and nothing more. */
  rank: 0 | 1 | 2 | 3;
  since: number;
}

export function lanesOf(world: World, now: number, options: LaneOptions = {}): Lanes {
  const shown = options.shown ?? LANES;

  // ── What is still going on ──
  const going = [...world.changes.values()].filter((change) => !OVER.has(change.state));
  const drawAll = going.length <= DRAW_ALL_UP_TO;
  // With a few agents, finished things stay a moment so they are seen to finish. A swarm has no room for that.
  const linger = drawAll ? LINGER_MS : 0;
  const conflicts = [...world.conflicts.values()].filter(
    (conflict) => !SETTLED.has(conflict.state) || now - (conflict.settledT ?? 0) < linger,
  );
  const unsettled = conflicts.filter((conflict) => !SETTLED.has(conflict.state));
  const contested = new Set(unsettled.flatMap((conflict) => conflict.parties));
  // An effect does not say what it contradicts: the conflict does, by naming the change that alters.
  const altering = new Set(
    unsettled.flatMap((conflict) => sidesOf(world, conflict)?.other.id ?? []),
  );
  const live = [
    ...going,
    ...[...world.changes.values()].filter(
      (change) => change.state === "landed" && now - (change.landedT ?? -Infinity) < linger,
    ),
  ];
  const bySubject = new Map<string, ChangeEntry[]>();
  for (const change of live) {
    const key = subjectOf(change);
    if (key !== undefined) bySubject.set(key, [...(bySubject.get(key) ?? []), change]);
  }
  const real = (change: ChangeEntry): boolean => world.agents.get(change.agentId)?.class === "real";
  // A question Keel has put to a person about a change itself, with no conflict between it and the answer.
  const asked = new Map<string, EscalationEntry[]>();
  for (const escalation of world.escalations.values()) {
    if (escalation.about.kind !== "change") continue;
    asked.set(escalation.about.id, [...(asked.get(escalation.about.id) ?? []), escalation]);
  }
  const waiting = (change: ChangeEntry): boolean =>
    (asked.get(change.id) ?? []).some((escalation) => escalation.state === "open");
  const notable = (change: ChangeEntry): boolean =>
    drawAll ||
    waiting(change) ||
    contested.has(change.id) ||
    change.state === "parked" ||
    change.state === "bounced" ||
    real(change);

  // ── Which subjects have a lane, and in what order ──
  const ranked = [...world.subjects.values()]
    .map((subject): Ranked => {
      const here = conflicts.filter((conflict) => conflict.subjectId === subject.id);
      const open = here.filter((conflict) => !SETTLED.has(conflict.state));
      const changes = bySubject.get(subject.key) ?? [];
      return {
        subject,
        here,
        open,
        changes,
        // A person is asked about a conflict here, or about one of the changes here.
        rank:
          open.some((conflict) => conflict.state === "escalated") || changes.some(waiting)
            ? 0
            : here.length > 0
              ? 1
              : changes.some(real)
                ? 2
                : 3,
        since: Math.min(...here.map((conflict) => Date.parse(conflict.openedAt))),
      };
    })
    // With a few agents a subject keeps its lane for what it has earned. A swarm's lanes are for what is going on.
    .filter(
      (lane) =>
        lane.changes.length > 0 ||
        lane.here.length > 0 ||
        (drawAll && (lane.subject.guardIds.length > 0 || lane.subject.decisionIds.length > 0)),
    )
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        a.since - b.since ||
        b.changes.length - a.changes.length ||
        a.subject.key.localeCompare(b.subject.key),
    );

  // The lanes shown: the first of them, and the one a reader has open if it comes after those.
  const pinned =
    options.pinned === undefined
      ? -1
      : ranked.findIndex((lane) => lane.subject.key === options.pinned);
  const showing =
    pinned >= shown
      ? [...ranked.slice(0, shown), ...ranked.slice(pinned, pinned + 1)]
      : ranked.slice(0, shown);
  /** A change, and beside it the agent working on it. Answers the change's node. */
  const draw = (
    change: ChangeEntry,
    nodes: GraphNode[],
    edges: GraphEdge[],
    holds?: { text: string; derived: boolean },
  ): string => {
    const by = world.agents.get(change.agentId);
    const changeNode = `change:${change.id}`;
    const place = where(world, change);
    nodes.push({
      id: changeNode,
      kind: "change",
      changeId: change.id,
      label: change.label,
      goal: change.goal,
      state: change.state,
      revision: change.revision,
      ...(holds === undefined ? {} : { holds }),
      ...(place === undefined ? {} : { where: place }),
      ...(change.unverified ? { unverified: true } : {}),
    });
    if (by !== undefined) {
      const agentNode = `agent:${by.id}:${change.id}`;
      nodes.push({
        id: agentNode,
        kind: "agent",
        label: by.name,
        agentClass: by.class,
        harness: by.harness,
      });
      edges.push({
        id: `${agentNode}>${changeNode}`,
        from: agentNode,
        to: changeNode,
        tone: "plain",
      });
    }
    // A question about the change itself hangs from the change: while it is open, it is what a person is asked.
    for (const escalation of asked.get(change.id) ?? []) {
      const escalationNode = `escalation:${escalation.id}`;
      nodes.push({
        id: escalationNode,
        kind: "escalation",
        escalationId: escalation.id,
        label: escalation.label,
        question: escalation.question,
        standing:
          escalation.options.find((option) => option.id === escalation.default)?.label ??
          escalation.default,
        state: escalation.state,
      });
      edges.push({
        id: `${changeNode}>${escalationNode}`,
        from: changeNode,
        to: escalationNode,
        tone: escalation.state === "open" ? "person" : "plain",
      });
    }
    return changeNode;
  };

  const lanes = showing.map((lane): Lane => {
    const { subject, here, open, changes } = lane;
    const { key } = subject;
    const guards = subject.guardIds
      .flatMap((id) => world.guards.get(id) ?? [])
      .filter((guard) => guard.state === "admitted");
    const tone: Tone =
      open.some((c) => c.state === "escalated") || changes.some(waiting)
        ? "person"
        : open.some((c) => c.state === "proven")
          ? "proven"
          : open.length > 0
            ? "suspected"
            : guards.length > 0
              ? "pass"
              : "plain";
    const subjectNode = `subject:${subject.id}`;
    const drawnSubject: Lane["subject"] = {
      id: subjectNode,
      kind: "subject",
      key,
      gloss: subject.gloss,
      premises: subject.premises.size,
      guards: guards.length,
      decisions: subject.decisionIds.length,
      tone,
    };
    const summary = {
      key,
      subject: drawnSubject,
      changes: changes.length,
      byState: tally(changes),
      conflicts: open.length,
    };
    const isOpen =
      options.closed?.has(key) === true
        ? false
        : options.opened?.has(key) === true || options.pinned === key
          ? true
          : drawAll || lane.rank < 3;
    if (!isOpen) return { ...summary, open: false, nodes: [], edges: [] };

    const nodes: GraphNode[] = [drawnSubject];
    const edges: GraphEdge[] = [];
    const edge = (from: string, to: string, more: Omit<GraphEdge, "id" | "from" | "to">): void => {
      edges.push({ id: `${from}>${to}`, from, to, ...more });
    };

    // Changes on this subject, each with the agent working on it. The ordinary ones of a swarm are counted.
    const drawn = changes.filter(notable);
    for (const change of drawn) {
      const tied = tie(change, key, altering.has(change.id));
      edge(draw(change, nodes, edges, tied.holds), subjectNode, {
        tone: tied.tone,
        ...(tied.holds?.derived === true ? { derived: true } : {}),
      });
    }
    const stacked = changes.filter((change) => !drawn.includes(change));
    if (stacked.length > 0) {
      const stackNode = `stack:${subject.id}`;
      nodes.push({
        id: stackNode,
        kind: "stack",
        subjectKey: key,
        count: stacked.length,
        beside: drawn.length,
        byState: tally(stacked),
      });
      edge(stackNode, subjectNode, { tone: "plain" });
    }

    // A conflict brings its probe and its question. A proven one leaves a guard, and a ruled one a decision.
    const chained = new Set<string>();
    for (const conflict of here) {
      const conflictNode = `conflict:${conflict.id}`;
      const conflictTone: Tone = SETTLED.has(conflict.state)
        ? "plain"
        : conflict.state === "proven" || conflict.state === "escalated"
          ? "proven"
          : "suspected";
      nodes.push({
        id: conflictNode,
        kind: "conflict",
        conflictId: conflict.id,
        label: conflict.label,
        conflictKind: conflict.kind,
        state: conflict.state,
        summary: conflict.summary,
        ...(conflict.costUsd === undefined ? {} : { costUsd: conflict.costUsd }),
      });
      edge(subjectNode, conflictNode, { tone: conflictTone });
      const probe = conflict.probeId === undefined ? undefined : world.probes.get(conflict.probeId);
      const guard = conflict.guardId === undefined ? undefined : world.guards.get(conflict.guardId);
      // What came of a conflict follows from its probe, where it has one.
      let last = conflictNode;
      if (probe !== undefined) {
        // The first run not yet in is the one running; the rest are still to come.
        let reached = probe.state !== "calibrating";
        const runs = WORLDS.map((id): [WorldId, (Outcome | Pending)[]] => [
          id,
          [0, 1, 2].map((index) => {
            const outcome = probe.runs[id][index];
            if (outcome !== undefined) return outcome;
            if (reached) return "pending";
            reached = true;
            return "running";
          }),
        ]);
        last = `probe:${probe.id}`;
        nodes.push({
          id: last,
          kind: "probe",
          conflictId: conflict.id,
          label: probe.label,
          state: probe.state,
          runs,
        });
        edge(conflictNode, last, { tone: "plain" });
        if (guard !== undefined) {
          chained.add(guard.id);
          nodes.push({
            id: `guard:${guard.id}`,
            kind: "guard",
            label: guard.label,
            state: guard.state,
          });
          edge(last, `guard:${guard.id}`, { tone: guard.state === "admitted" ? "pass" : "plain" });
        }
      }
      const escalation =
        conflict.escalationId === undefined
          ? undefined
          : world.escalations.get(conflict.escalationId);
      if (escalation !== undefined) {
        const decision =
          conflict.decisionId === undefined ? undefined : world.decisions.get(conflict.decisionId);
        if (decision !== undefined) chained.add(decision.id);
        const escalationNode = `escalation:${escalation.id}`;
        nodes.push({
          id: escalationNode,
          kind: "escalation",
          escalationId: escalation.id,
          label: escalation.label,
          question: escalation.question,
          standing:
            escalation.options.find((option) => option.id === escalation.default)?.label ??
            escalation.default,
          state: escalation.state,
          ...(decision === undefined
            ? {}
            : { decision: { label: decision.label, chosen: decision.chosen } }),
        });
        edge(last, escalationNode, { tone: escalation.state === "open" ? "person" : "plain" });
      }
    }
    // Once the conflict has left, what it earned stays in its subject's lane. A swarm's subject counts them instead.
    if (drawAll) {
      for (const guard of guards) {
        if (!chained.has(guard.id))
          nodes.push({
            id: `guard:${guard.id}`,
            kind: "guard",
            label: guard.label,
            state: guard.state,
          });
      }
      for (const id of subject.decisionIds) {
        const decision = world.decisions.get(id);
        if (decision !== undefined && !chained.has(id))
          nodes.push({
            id: `decision:${id}`,
            kind: "decision",
            label: decision.label,
            chosen: decision.chosen,
          });
      }
    }
    return { ...summary, open: true, nodes, edges };
  });

  // ── The changes on no subject ──
  // A change that has declared no premise, and that Keel has derived no effect for, is about no subject yet;
  // so is one whose subject Keel has not minted. They are still work in progress, and are drawn as that: a
  // lane of their own, after every subject's.
  const placed = new Set(ranked.flatMap((lane) => lane.changes.map((change) => change.id)));
  // In the order they were declared, so that a change keeps its place as it lands beside one still going.
  const loose = live
    .filter((change) => !placed.has(change.id))
    .toSorted((a, b) => a.declaredT - b.declaredT);
  if (loose.length > 0) {
    const stillGoing = loose.filter((change) => !OVER.has(change.state));
    const summary = {
      key: NO_SUBJECT,
      changes: stillGoing.length,
      byState: tally(stillGoing),
      conflicts: 0,
    };
    const drawn = loose.filter(notable);
    const isOpen =
      options.closed?.has(NO_SUBJECT) === true
        ? false
        : options.opened?.has(NO_SUBJECT) === true || drawn.length > 0;
    if (isOpen) {
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      // Opened by a reader, a swarm's lane draws every change in it: none of them has a subject to be counted beside.
      for (const change of drawn.length > 0 ? drawn : loose) draw(change, nodes, edges);
      // Where a person is asked about one of them, this lane comes first, as a subject's would.
      if (loose.some(waiting)) lanes.unshift({ ...summary, open: true, nodes, edges });
      else lanes.push({ ...summary, open: true, nodes, edges });
    } else lanes.push({ ...summary, open: false, nodes: [], edges: [] });
  }

  const rest = ranked.filter((lane) => !showing.includes(lane));
  const of = (agentClass: AgentClass): number =>
    [...world.agents.values()].filter((agent) => agent.class === agentClass).length;
  return {
    agents: { real: of("real"), hosted: of("hosted"), synthetic: of("synthetic") },
    changes: going.length,
    lanes,
    more: {
      lanes: rest.length,
      changes: rest.reduce((sum, lane) => sum + lane.changes.length, 0),
      conflicts: rest.reduce((sum, lane) => sum + lane.open.length, 0),
    },
  };
}
