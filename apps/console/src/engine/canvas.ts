// The Pipeline: everything moving through Keel right now, read off
// the log. Who is changing what (agents and their runs), where each change
// stands (declared, precheck, queue, in a batch, bounced back), the batches in
// flight with the batches they were formed on, what verification said, and
// what trunk took. Each field is set from an event of Keel's, named beside it.
// Where Keel says nothing (a step's own start and end) the canvas says so.

import type { AgentClass } from "../domain/state.ts";
import {
  type BatchEnd,
  type FlowBatch,
  type FlowChange,
  type Stage,
  waitsOnItsAgent,
} from "./flow.ts";
import type { Cards } from "./holder.ts";
import type { ChangeEntry, World } from "./world.ts";

/** Live changes past which every stage is drawn as one lane of dots. */
export const DENSE_AT = 150;
/** Changes in one stage past which that stage alone is drawn as dots. */
export const COLUMN_DENSE_AT = 20;
/** Agents drawn one by one; the rest are counted in one node. */
export const AGENTS_SHOWN = 24;
/** Runs listed under an agent; the rest are counted. */
export const RUNS_SHOWN = 8;
/** A batch's members drawn as chips; the rest are counted. */
export const MEMBERS_SHOWN = 8;
/** Batches in flight past which each is drawn as one compact row. */
export const BATCHES_COMPACT_AT = 12;
/** How long a batch that ended without landing stays on the canvas after it ended. */
export const LINGER_MS = 45_000;
/** A change that has not moved for this long is drawn quiet. */
export const QUIET_MS = 30 * 60_000;
/** How many colours agents are told apart by. */
export const HUES = 8;
/** Trunk's advances drawn on its spine. */
export const COMMITS_SHOWN = 10;
/** The span of the landing rate. */
export const RATE_SPAN_MS = 10 * 60_000;

/** The stages a change chip is drawn in outside a batch. */
export type ChipStage = Extract<Stage, "declared" | "precheck" | "queue" | "bounced">;
export const CHIP_STAGES: readonly ChipStage[] = ["bounced", "declared", "precheck", "queue"];

export interface CanvasChange {
  id: string;
  /** `#n`. */
  label: string;
  goal: string;
  agentId: string;
  /** The run it is held under, where its holder's token named one. */
  runId?: string;
  /** Its run's colour, or its agent's where it names no run: who is changing what, without an edge. */
  hue: number;
  stage: ChipStage | "batch";
  /** When it came into its stage, in the log's own milliseconds. */
  since: number;
  from?: Stage;
  moves: number;
  batchId?: string;
  parked?: { reason: string; escalationId?: string };
  requeued?: string;
  /** The first reason Keel gave for its latest bounce, in Keel's words. */
  bounced?: string;
  /** What Keel has said of it so far: effects and premises derived, its plan's steps. */
  facts: string[];
  revision: number;
  quiet: boolean;
}

/** What one step of a batch's plan came to, from the verdict's evidence. */
export interface CanvasStep {
  name: string;
  result: "pass" | "fail" | "abstain" | "escalate" | "annotate" | "said";
  tier?: number;
  /** The verdict's whole line, in Keel's words. */
  line: string;
}

export type BatchState =
  | "forming"
  | "assembled"
  | "verifying"
  | "green"
  | "promoting"
  | "red"
  | "cancelled"
  | "bisected"
  | "declined";

export interface CanvasBatch {
  id: string;
  /** `batch n`, by the order Keel formed them in this log. */
  label: string;
  members: string[];
  shown: string[];
  more: number;
  state: BatchState;
  /** How many batches in flight it was formed on: 0 is on trunk. */
  depth: number;
  /** The batch in flight it rests on, where it rests on one. */
  on?: string;
  attempt: number;
  tier?: number;
  composer?: string;
  formedT: number;
  verifyingT?: number;
  endedT?: number;
  steps: CanvasStep[];
  /** What Keel blamed a red batch on, or why it cancelled or declined it, in Keel's words. */
  why?: string;
}

export interface CanvasAgent {
  id: string;
  name: string;
  handle?: string;
  agentClass?: AgentClass;
  hue: number;
  runs: { id: string; label: string; changes: number; hue: number }[];
  moreRuns: number;
  changes: number;
  /** Of its changes, those live: not waiting on it after its lease lapsed. */
  live: number;
}

export interface CanvasCommit {
  height: number;
  sha: string;
  t: number;
  changes: { id: string; label: string; hue: number }[];
  verified: boolean;
}

export interface CanvasEdge {
  id: string;
  kind: "conflict" | "same";
  from: string;
  to: string;
  /** The subject and the kind of a conflict; nothing for same intent. */
  label: string;
  state: "suspected" | "proven";
  subject?: string;
}

export interface Answers {
  /** Verified advances with no red audit, of all advances. */
  green: number;
  advances: number;
  /** Advances Keel took with verification off: never green, whatever came of them. */
  unverified: number;
  /** Conflicts Keel proved before trunk, and batches it failed for a clash between members. */
  caught: number;
  /** Changes bounced by a verdict or a conflict that went on to land with no ruling against them. */
  recovered: number;
  bounced: number;
  /** Landings a minute over the last ten. */
  perMinute: number;
}

export interface Canvas {
  agents: CanvasAgent[];
  /** Agents with a live change not drawn one by one. */
  moreAgents: number;
  changes: CanvasChange[];
  batches: CanvasBatch[];
  commits: CanvasCommit[];
  edges: CanvasEdge[];
  counts: Record<ChipStage | "batches" | "verifying" | "landed" | "agents", number>;
  answers: Answers;
  /** Live changes: not landed, withdrawn or superseded. */
  live: number;
  /** Past `DENSE_AT` live changes: every stage is drawn as dots, and no edge is drawn. */
  dense: boolean;
  /** The stages drawn as dots: every one when dense, else each past `COLUMN_DENSE_AT`. */
  dotted: ChipStage[];
  compact: boolean;
}

/** An agent's colour, the same on every reading of every log: a hash of its id. */
export function hueOf(agentId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < agentId.length; index += 1)
    hash = Math.imul(hash ^ agentId.codePointAt(index)!, 16_777_619);
  return (hash >>> 0) % HUES;
}

const STEP_LINE = /^([\w.:-]+?):\s+(pass|fail|abstain|escalate|annotate)\b(?:[^)]*?tier (\d))?/;

/**
 * What each step of a plan came to, from a verdict's evidence lines as Keel writes them (`keel.test: fail (proof,
 * tier 2: …) evidence sha256:…`). A step named twice is its later line. A line in no step's form is kept as said.
 */
const RESULT: Readonly<Record<string, CanvasStep["result"]>> = {
  pass: "pass",
  fail: "fail",
  abstain: "abstain",
  escalate: "escalate",
  annotate: "annotate",
};

export function stepsOf(evidence: readonly string[]): CanvasStep[] {
  const steps = new Map<string, CanvasStep>();
  for (const line of evidence) {
    const match = STEP_LINE.exec(line);
    if (match === null) {
      steps.set(line, { name: line, result: "said", line });
      continue;
    }
    const [, name = line, result = "said", tier] = match;
    steps.set(name, {
      name,
      result: RESULT[result] ?? "said",
      ...(tier === undefined ? {} : { tier: Number(tier) }),
      line,
    });
  }
  return [...steps.values()];
}

const ENDED_STATE: Record<BatchEnd, BatchState> = {
  green: "green",
  promoted: "promoting",
  landed: "promoting",
  red: "red",
  invalidated: "cancelled",
  bisected: "bisected",
  declined: "declined",
};

export function batchState(batch: FlowBatch): BatchState {
  if (batch.ended !== undefined) return ENDED_STATE[batch.ended.how];
  if (batch.verifyingT !== undefined) return "verifying";
  return batch.assembled === undefined ? "forming" : "assembled";
}

/**
 * Whether a batch is still drawn: in flight, passed and not yet on trunk, or ended a moment ago. A passed batch
 * whose every change Keel has landed is on trunk, whichever event said so first.
 */
function drawn(batch: FlowBatch, now: number, changes: ReadonlyMap<string, FlowChange>): boolean {
  const how = batch.ended?.how;
  if (how === undefined) return true;
  if (how === "landed") return false;
  if (how === "green" || how === "promoted")
    return !batch.members.every((id) => changes.get(id)?.stage === "landed");
  return now - (batch.ended?.t ?? now) < LINGER_MS;
}

function factsOf(change: ChangeEntry): string[] {
  return [
    change.derived ? `${change.effects.length} effects` : "",
    change.premises.length > 0 ? `${change.premises.length} premises` : "",
    change.plan === undefined ? "" : `${change.plan.stepCount} steps`,
  ].filter((fact) => fact !== "");
}

function chipOf(world: World, flow: FlowChange, now: number): CanvasChange | undefined {
  const change = world.changes.get(flow.id);
  if (change === undefined) return undefined;
  if (flow.stage === "landed" || flow.stage === "gone") return undefined;
  return {
    id: change.id,
    label: change.label,
    goal: change.goal,
    agentId: change.agentId,
    ...(change.run === undefined ? {} : { runId: change.run.id }),
    hue: hueOf(change.run?.id ?? change.agentId),
    stage: flow.stage,
    since: flow.since,
    ...(flow.from === undefined ? {} : { from: flow.from }),
    moves: flow.moves,
    ...(change.batchId === undefined || flow.stage !== "batch" ? {} : { batchId: change.batchId }),
    ...(flow.parked === undefined ? {} : { parked: flow.parked }),
    ...(flow.requeued === undefined ? {} : { requeued: flow.requeued }),
    ...(flow.stage === "bounced" && change.bounce?.reasons[0] !== undefined
      ? { bounced: change.bounce.reasons[0] }
      : {}),
    facts: factsOf(change),
    revision: change.revision,
    quiet: now - flow.since > QUIET_MS,
  };
}

/** The batch in flight each batch rests on: the latest-formed one that holds one of its predecessors. */
function chainOf(batches: readonly FlowBatch[]): Map<string, FlowBatch> {
  const holder = new Map<string, FlowBatch>();
  const on = new Map<string, FlowBatch>();
  for (const batch of batches) {
    let under: FlowBatch | undefined;
    for (const changeId of batch.predecessors) {
      const held = holder.get(changeId);
      if (held !== undefined && (under === undefined || held.formedT > under.formedT)) under = held;
    }
    if (under !== undefined) on.set(batch.id, under);
    for (const member of batch.members) holder.set(member, batch);
  }
  return on;
}

export function whyOf(batch: FlowBatch, world: World): string | undefined {
  const ended = batch.ended;
  if (ended === undefined) return undefined;
  if (ended.reason !== undefined) return ended.reason;
  if (ended.attribution === undefined) return undefined;
  return world.changes.get(ended.attribution)?.label ?? ended.attribution;
}

/** Everything the canvas draws, as it stands at `now` in the log's own milliseconds. */
export function canvasOf(world: World, now: number, cards: Cards = new Map()): Canvas {
  const { flow } = world;
  const chips: CanvasChange[] = [];
  for (const entry of flow.changes.values()) {
    const chip = chipOf(world, entry, now);
    if (chip !== undefined) chips.push(chip);
  }
  const byId = new Map(chips.map((chip) => [chip.id, chip]));

  // Batches, in the order Keel formed them, numbered by that order.
  const formed = [...flow.batches.values()].toSorted((a, b) => a.formedT - b.formedT);
  const number = new Map(formed.map((batch, index) => [batch.id, index + 1]));
  const on = chainOf(formed);
  const depth = new Map<string, number>();
  for (const batch of formed) {
    const under = on.get(batch.id);
    depth.set(batch.id, under === undefined ? 0 : (depth.get(under.id) ?? 0) + 1);
  }
  const shownBatches = formed.filter((batch) => drawn(batch, now, flow.changes));
  const batches: CanvasBatch[] = shownBatches.map((batch) => {
    const verdict =
      batch.ended?.verdictId === undefined ? undefined : world.verdicts.get(batch.ended.verdictId);
    const under = on.get(batch.id);
    const why = whyOf(batch, world);
    const members = batch.members.filter((id) => world.changes.has(id));
    return {
      id: batch.id,
      label: `batch ${number.get(batch.id) ?? 0}`,
      members,
      shown: members.slice(0, MEMBERS_SHOWN),
      more: Math.max(0, members.length - MEMBERS_SHOWN),
      state: batchState(batch),
      depth: depth.get(batch.id) ?? 0,
      ...(under !== undefined && drawn(under, now, flow.changes)
        ? { on: `batch ${number.get(under.id) ?? 0}` }
        : {}),
      attempt: batch.attempt,
      ...(batch.assembled === undefined
        ? {}
        : { tier: batch.assembled.tier, composer: batch.assembled.composer }),
      formedT: batch.formedT,
      ...(batch.verifyingT === undefined ? {} : { verifyingT: batch.verifyingT }),
      ...(batch.ended === undefined ? {} : { endedT: batch.ended.t }),
      steps: verdict === undefined ? [] : stepsOf(verdict.evidence),
      ...(why === undefined ? {} : { why }),
    };
  });

  // Agents: each one that holds a live change, with the runs it holds them under.
  const agentsById = new Map<string, CanvasAgent>();
  for (const chip of chips) {
    let agent = agentsById.get(chip.agentId);
    if (agent === undefined) {
      const card = cards.get(chip.agentId);
      const enrolled = world.agents.get(chip.agentId);
      agent = {
        id: chip.agentId,
        name: card?.name ?? enrolled?.name ?? "Agent",
        ...(card?.handle === undefined ? {} : { handle: card.handle }),
        ...(enrolled === undefined ? {} : { agentClass: enrolled.class }),
        hue: hueOf(chip.agentId),
        runs: [],
        moreRuns: 0,
        changes: 0,
        live: 0,
      };
      agentsById.set(chip.agentId, agent);
    }
    agent.changes += 1;
    if (!waitsOnItsAgent(chip)) agent.live += 1;
    const run = world.changes.get(chip.id)?.run;
    if (run !== undefined) {
      const listed = agent.runs.find((each) => each.id === run.id);
      if (listed === undefined)
        agent.runs.push({ id: run.id, label: run.label ?? "run", changes: 1, hue: chip.hue });
      else listed.changes += 1;
    }
  }
  const allAgents = [...agentsById.values()].toSorted(
    (a, b) => b.changes - a.changes || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  for (const agent of allAgents) {
    agent.runs.sort((a, b) => b.changes - a.changes || a.label.localeCompare(b.label));
    agent.moreRuns = Math.max(0, agent.runs.length - RUNS_SHOWN);
    agent.runs = agent.runs.slice(0, RUNS_SHOWN);
  }
  const agents = allAgents.slice(0, AGENTS_SHOWN);

  // Edges between two changes both on the canvas.
  const edges: CanvasEdge[] = [];
  for (const conflict of world.conflicts.values()) {
    if (
      conflict.state !== "suspected" &&
      conflict.state !== "probing" &&
      conflict.state !== "proven"
    )
      continue;
    const [a, b] = conflict.parties;
    if (a === undefined || b === undefined || !byId.has(a) || !byId.has(b)) continue;
    edges.push({
      id: `conflict:${conflict.id}`,
      kind: "conflict",
      from: a,
      to: b,
      label: [conflict.subjectKey, conflict.kind].filter((part) => part !== undefined).join(" · "),
      state: conflict.state === "proven" ? "proven" : "suspected",
      ...(conflict.subjectKey === undefined ? {} : { subject: conflict.subjectKey }),
    });
  }
  const paired = new Set<string>();
  for (const chip of chips) {
    for (const alternative of world.changes.get(chip.id)?.alternatives ?? []) {
      if (!byId.has(alternative.changeId)) continue;
      const key = [chip.id, alternative.changeId].toSorted().join(" ");
      if (paired.has(key)) continue;
      paired.add(key);
      edges.push({
        id: `same:${key}`,
        kind: "same",
        from: chip.id,
        to: alternative.changeId,
        label: "",
        state: "suspected",
      });
    }
  }

  const commits: CanvasCommit[] = flow.commits.slice(0, COMMITS_SHOWN).map((commit) => ({
    height: commit.height,
    sha: commit.sha,
    t: commit.t,
    verified: commit.verified,
    changes: commit.changes.map((id) => {
      const change = world.changes.get(id);
      return {
        id,
        label: change?.label ?? id.slice(-4),
        hue: hueOf(change?.run?.id ?? change?.agentId ?? id),
      };
    }),
  }));

  const counts = {
    agents: allAgents.length,
    bounced: 0,
    declared: 0,
    precheck: 0,
    queue: 0,
    batches: batches.filter((batch) => batch.endedT === undefined).length,
    verifying: batches.filter((batch) => batch.state === "verifying").length,
    landed: flow.landings.length,
  };
  for (const chip of chips) if (chip.stage !== "batch") counts[chip.stage] += 1;

  return {
    agents,
    moreAgents: allAgents.length - agents.length,
    changes: chips,
    batches,
    commits,
    edges,
    counts,
    answers: answersOf(world, now),
    // A change waiting on its agent, whose lease lapsed, is drawn where it stands, and is not live.
    live: chips.filter((chip) => !waitsOnItsAgent(chip)).length,
    dense: chips.length > DENSE_AT,
    dotted: CHIP_STAGES.filter(
      (stage) => chips.length > DENSE_AT || counts[stage] > COLUMN_DENSE_AT,
    ),
    compact: batches.length > BATCHES_COMPACT_AT,
  };
}

/** The four answers the header gives, live. */
export function answersOf(world: World, now: number): Answers {
  const { trunk, flow } = world;
  let caught = 0;
  for (const conflict of world.conflicts.values()) if (conflict.proven !== undefined) caught += 1;
  for (const batch of flow.batches.values())
    if (
      batch.ended?.how === "red" &&
      (batch.ended.attribution === "textual" || batch.ended.attribution === "interaction")
    )
      caught += 1;
  let bounced = 0;
  let recovered = 0;
  for (const change of world.changes.values()) {
    if (change.bounces.verdict + change.bounces.conflict === 0) continue;
    bounced += 1;
    if (change.state === "landed" && change.bounces.ruling === 0) recovered += 1;
  }
  const since = now - RATE_SPAN_MS;
  const recent = flow.landings.filter((t) => t > since && t <= now).length;
  return {
    green: Math.max(0, trunk.advances - trunk.redCount - trunk.unverifiedAdvances),
    advances: trunk.advances,
    unverified: trunk.unverifiedAdvances,
    caught,
    recovered,
    bounced,
    perMinute: recent / (RATE_SPAN_MS / 60_000),
  };
}
