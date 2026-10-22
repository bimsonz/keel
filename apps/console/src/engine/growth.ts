// Mission Control as an architecture diagram that grows outward as Keel works.
// The project is the centre. A change declared on it is a fork off it, with the
// agents working on it beside it. Keel's batch is where forks join, further
// out; its checks come off the batch, and a deploy after them where the project
// deploys. A landing runs back into the project, and then the fork's whole
// branch dissolves. A bounce runs red from the check that failed back to the
// fork, which stays until it is revised. Each branch keeps its angle from the
// moment it is placed, so nothing placed ever jumps; past what fits, the forks
// that are only waiting are counted in a pile beside the project.

import { agentName } from "./audience.ts";
import { type BatchState, type CanvasStep, batchState, stepsOf, whyOf } from "./canvas.ts";
import { type FlowBatch, type FlowChange, type Stage, waitsOnItsAgent } from "./flow.ts";
import type { Cards } from "./holder.ts";
import { authorAgentOf, type World } from "./world.ts";

/** How long a landed branch takes to dissolve. */
export const DISSOLVE_MS = 30_000;
/** A change that moved this recently is moving. */
export const MOVING_MS = 90_000;
/** A bounce left this long without a revision has settled: its fork is counted in the bounced pile, its batch not drawn. */
export const SETTLED_MS = 10 * 60_000;
/** Forks drawn one by one round the project. */
export const FORK_SLOTS = 16;
/** Places for batches on their ring. */
export const BATCH_SLOTS = 28;
/** How much wider than tall the rings are, to fill a screen. */
const STRETCH = 1.8;
/** The space between a fork and its agent. */
const AGENT_GAP = 12;
/** Each ring's height from the centre. */
export const RING = { pile: 175, fork: 340, batch: 600, check: 820, deploy: 1040 } as const;

export const SIZE = {
  project: { w: 280, h: 108 },
  fork: { w: 196, h: 64 },
  agent: { w: 188, h: 24 },
  pile: { w: 148, h: 42 },
  batch: { w: 188, h: 64 },
  check: { w: 200, h: 32 },
  deploy: { w: 176, h: 46 },
} as const;

export type Standing = "moving" | "waiting" | "stuck" | "done";

interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1 while it stands, down to 0 as its branch dissolves. */
  fade: number;
}

export interface ProjectNode extends Placed {
  kind: "project";
  name: string;
  /** Trunk's head: whether Keel verified it is not known while the diagram is drawn from a snapshot. */
  head?: { height: number; sha: string; verified?: boolean };
  live: number;
  landed: number;
}
export interface ForkNode extends Placed {
  kind: "fork";
  changeId: string;
  label: string;
  goal: string;
  stage: Stage;
  since: number;
  standing: Standing;
  /** Why it bounced or is parked, in Keel's words. */
  why?: string;
  /** Whether it is parked on a question put to a person. */
  escalated?: boolean;
  /** Whether it waits on its agent, whose lease lapsed: not stuck on anything of Keel's, and not live. */
  idle?: boolean;
}
export interface AgentNode extends Placed {
  kind: "agent";
  agentId: string;
  name: string;
  run?: string;
}
export type PileStage = "declared" | "precheck" | "queue" | "bounced";
export interface PileNode extends Placed {
  kind: "pile";
  stage: PileStage;
  count: number;
}
export interface BatchNode extends Placed {
  kind: "batch";
  batchId: string;
  label: string;
  state: BatchState;
  members: number;
  formedT: number;
  verifyingT?: number;
  endedT?: number;
  why?: string;
}
export interface CheckNode extends Placed {
  kind: "check";
  name: string;
  /**
   * What the step came to, or running while its batch verifies and Keel has not said, or stopped where the batch
   * ended with the step started and not finished.
   */
  result: CanvasStep["result"] | "running" | "stopped";
  since?: number;
  /** How long the runner took over a finished step, in its own figure. */
  took?: number;
  line?: string;
}
export interface DeployNode extends Placed {
  kind: "deploy";
  url: string;
  down: boolean;
}

export type GrowthNode =
  | ProjectNode
  | ForkNode
  | AgentNode
  | PileNode
  | BatchNode
  | CheckNode
  | DeployNode;

export type GrowthEdgeKind =
  | "fork"
  | "works"
  | "join"
  | "test"
  | "ship"
  | "land"
  | "fail"
  | "chain";

export interface GrowthEdge {
  id: string;
  kind: GrowthEdgeKind;
  source: string;
  target: string;
  /** Work is moving along it now. */
  moving: boolean;
  fade: number;
}

export interface Growth {
  nodes: GrowthNode[];
  edges: GrowthEdge[];
  bounds: Bounds;
  /** What the view is fitted to: everything but the checks and deploys, which may sit at its edge. */
  focus: Bounds;
  /** The runs named by the changes drawn or piled: one account's many runs are as many agents at work. */
  runs: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The box round some nodes. */
function boundsOf(nodes: readonly Pick<Placed, "x" | "y" | "w" | "h">[]): Bounds {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    x1 = Math.max(x1, node.x + node.w);
    y1 = Math.max(y1, node.y + node.h);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Where each fork and batch was put, kept across readings so that nothing placed moves. */
export interface Kept {
  fork: Map<string, number>;
  batch: Map<string, number>;
  /** The slot the next fork is tried in first, so forks declared one after another sit side by side. */
  next: number;
}

export const keptAfresh = (): Kept => ({ fork: new Map(), batch: new Map(), next: 0 });

const TURN = Math.PI * 2;
const TOP = -Math.PI / 2;

/** A point on a ring, at an angle measured clockwise from the right. */
const at = (ring: number, angle: number) => ({
  x: STRETCH * ring * Math.cos(angle),
  y: ring * Math.sin(angle),
});

const box = (id: string, size: { w: number; h: number }, centre: { x: number; y: number }) => ({
  id,
  x: centre.x - size.w / 2,
  y: centre.y - size.h / 2,
  w: size.w,
  h: size.h,
});

const slotAngle = (slot: number, slots: number) => TOP + (slot * TURN) / slots;

/** The mean of some angles, as directions. */
function meanAngle(angles: readonly number[]): number {
  let [x, y] = [0, 0];
  for (const angle of angles) {
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  return Math.atan2(y, x);
}

const gap = (a: number, b: number) => {
  const d = Math.abs(a - b) % TURN;
  return Math.min(d, TURN - d);
};

/** The latest batch a change was put in, by when Keel formed it. */
function lastBatchOf(id: string, batches: Iterable<FlowBatch>): FlowBatch | undefined {
  let last: FlowBatch | undefined;
  for (const batch of batches)
    if (batch.members.includes(id) && (last === undefined || batch.formedT > last.formedT))
      last = batch;
  return last;
}

// Piles sit between two forks' places, off the lines out to them.
const HALF_SLOT = Math.PI / FORK_SLOTS;
const PILE_ANGLE: Record<PileStage, number> = {
  declared: Math.PI + HALF_SLOT,
  precheck: Math.PI / 2 + HALF_SLOT,
  queue: HALF_SLOT,
  bounced: -Math.PI / 2 + HALF_SLOT,
};

/** Which of the live forks are drawn one by one first: what Keel is doing something with. */
const URGENCY: Record<Stage, number> = {
  bounced: 0,
  batch: 1,
  precheck: 2,
  queue: 3,
  declared: 4,
  landed: 5,
  gone: 6,
};

/** The pile a fork waiting at this stage is counted in. */
function pileOf(stage: Stage): PileStage | undefined {
  return stage === "declared" || stage === "precheck" || stage === "queue" || stage === "bounced"
    ? stage
    : undefined;
}

/** Where a fork's agent sits: on its outer side, at its outer corner, clear of the line in from the project. */
function agentBeside(centre: { x: number; y: number }): { x: number; y: number } {
  const outward = { x: centre.x >= 0 ? 1 : -1, y: centre.y >= 0 ? 1 : -1 };
  return {
    x: centre.x + (outward.x * (SIZE.fork.w - SIZE.agent.w)) / 2,
    y: centre.y + outward.y * (SIZE.fork.h / 2 + AGENT_GAP + SIZE.agent.h / 2),
  };
}

/** Why Keel parked a change, in the words the list of changes uses: never its reason's own token. */
const PARKED_WHY: Readonly<Record<string, string>> = {
  "lease-lapsed": "Waiting on its agent: its lease lapsed",
  "awaiting-ruling": "Waiting on a person's ruling",
};

function standingOf(change: FlowChange, now: number): Standing {
  if (change.stage === "landed") return "done";
  if (change.stage === "bounced") return "stuck";
  // Its agent's lease lapsed: it waits on its agent, as the list of changes says, and nothing is stuck.
  if (waitsOnItsAgent(change)) return "waiting";
  if (change.parked !== undefined) return "stuck";
  if (change.stage === "precheck" || change.stage === "batch" || now - change.since < MOVING_MS)
    return "moving";
  return "waiting";
}

/**
 * The diagram while the log is read, from Keel's snapshot of its head (seed.ts): the project alone, with trunk's
 * height and head, its live changes and its landings, each as the log gives it once read. Whether Keel verified
 * trunk's head, and every fork, wait for the log: the snapshot says where a change stands but not since when, nor
 * whether one whose agent's lease lapsed bounced first, so a fork drawn from it would move or retime when the log
 * took over. The view is fitted to the places the forks will be given, so it does not jump when they come.
 */
export function seededGrowthOf(seeded: World, name: string): Growth {
  let live = 0;
  let landed = 0;
  let standing = 0;
  for (const change of seeded.changes.values()) {
    if (change.state === "landed") landed += 1;
    else if (change.state !== "withdrawn" && change.state !== "superseded") {
      standing += 1;
      // Not live while it waits on its agent, as `waitsOnItsAgent` has it of the log's.
      if (change.parkedOn !== "lease-lapsed") live += 1;
    }
  }
  const { head, advances } = seeded.trunk;
  const project: ProjectNode = {
    ...box("project", SIZE.project, { x: 0, y: 0 }),
    fade: 1,
    kind: "project",
    name,
    ...(head === "" ? {} : { head: { height: advances, sha: head } }),
    live,
    landed,
  };
  // The places the first forks are given, from the top round, each with its agent beside it.
  const places = Array.from({ length: Math.min(standing, FORK_SLOTS) }, (_, slot) => {
    const centre = at(RING.fork, slotAngle(slot, FORK_SLOTS));
    return [box("", SIZE.fork, centre), box("", SIZE.agent, agentBeside(centre))];
  }).flat();
  return {
    nodes: [project],
    edges: [],
    bounds: boundsOf([project]),
    focus: boundsOf([project, ...places]),
    runs: 0,
  };
}

/** The diagram of the project `name` as its log stands at `now`, placed where `kept` put each thing before. */
export function growthOf(
  world: World,
  now: number,
  name: string,
  kept: Kept,
  cards: Cards = new Map(),
): Growth {
  const flow = world.flow;
  const nodes: GrowthNode[] = [];
  const edges: GrowthEdge[] = [];
  const head = flow.commits[0];
  let live = 0;
  for (const change of flow.changes.values())
    if (change.stage !== "landed" && change.stage !== "gone" && !waitsOnItsAgent(change)) live += 1;
  const project: ProjectNode = {
    ...box("project", SIZE.project, { x: 0, y: 0 }),
    fade: 1,
    kind: "project",
    name,
    ...(head === undefined
      ? {}
      : { head: { height: head.height, sha: head.sha, verified: head.verified } }),
    live,
    landed: flow.landings.length,
  };
  nodes.push(project);

  // A fork stands while it is live, and a landed one while it dissolves.
  const fadeOf = (change: FlowChange): number =>
    change.stage === "landed" ? 1 - (now - change.since) / DISSOLVE_MS : 1;
  const standing = [...flow.changes.values()].filter(
    (change) => change.stage !== "gone" && fadeOf(change) > 0,
  );
  // Forks placed before keep their place while they stand; the rest are given the free places, most urgent first.
  const settled = (change: FlowChange): boolean =>
    change.stage === "bounced" && now - change.since > SETTLED_MS;
  for (const id of kept.fork.keys()) {
    const change = standing.find((each) => each.id === id);
    if (change === undefined || settled(change)) kept.fork.delete(id);
  }
  const taken = new Set(kept.fork.values());
  const waiting = standing
    // A landed fork not placed before (the page opened as it landed) takes a place only if one is free.
    .filter((change) => !kept.fork.has(change.id) && !settled(change))
    .toSorted(
      (a, b) =>
        URGENCY[a.stage] - URGENCY[b.stage] ||
        (world.changes.get(a.id)?.declaredT ?? 0) - (world.changes.get(b.id)?.declaredT ?? 0),
    );
  for (const change of waiting) {
    if (taken.size >= FORK_SLOTS) break;
    let slot = kept.next % FORK_SLOTS;
    while (taken.has(slot)) slot = (slot + 1) % FORK_SLOTS;
    kept.fork.set(change.id, slot);
    taken.add(slot);
    kept.next = slot + 1;
  }

  const forkAngle = new Map<string, number>();
  const piled = new Map<PileStage, string[]>();
  for (const change of standing) {
    const slot = kept.fork.get(change.id);
    if (slot === undefined) {
      const stage = pileOf(change.stage);
      if (stage !== undefined) piled.set(stage, [...(piled.get(stage) ?? []), change.id]);
      continue;
    }
    const angle = slotAngle(slot, FORK_SLOTS);
    forkAngle.set(change.id, angle);
    const entry = world.changes.get(change.id);
    const fade = Math.max(0, Math.min(1, fadeOf(change)));
    const centre = at(RING.fork, angle);
    const fork: ForkNode = {
      ...box(`fork:${change.id}`, SIZE.fork, centre),
      fade,
      kind: "fork",
      changeId: change.id,
      label: entry?.label ?? change.id,
      goal: entry?.goal ?? "",
      stage: change.stage,
      since: change.since,
      standing: standingOf(change, now),
      ...(change.parked !== undefined && entry?.escalationId !== undefined
        ? { escalated: true }
        : {}),
      ...(waitsOnItsAgent(change) && change.stage !== "bounced" ? { idle: true } : {}),
      ...(change.parked !== undefined
        ? { why: PARKED_WHY[change.parked.reason] ?? "Parked by Keel" }
        : entry?.bounce?.reasons[0] !== undefined && change.stage === "bounced"
          ? { why: entry.bounce.reasons[0] }
          : {}),
    };
    nodes.push(fork);
    edges.push({
      id: `fork:${change.id}`,
      kind: "fork",
      source: "project",
      target: fork.id,
      moving:
        fork.standing === "moving" && (change.stage === "declared" || change.stage === "precheck"),
      fade,
    });
    // A proposal no agent made has nobody to draw beside it.
    const author = entry === undefined ? undefined : authorAgentOf(entry);
    if (entry !== undefined && author !== undefined) {
      const agentCentre = agentBeside(centre);
      const called = agentName(world.agents.get(author), cards.get(author));
      const agent: AgentNode = {
        ...box(`agent:${change.id}:${author}`, SIZE.agent, agentCentre),
        fade,
        kind: "agent",
        agentId: author,
        name: called ?? "Agent",
        ...(entry.run === undefined ? {} : { run: entry.run.label ?? entry.run.id }),
      };
      nodes.push(agent);
      edges.push({
        id: `works:${agent.id}`,
        kind: "works",
        source: agent.id,
        target: fork.id,
        moving: false,
        fade,
      });
    }
  }

  for (const [stage, ids] of piled) {
    const pile: PileNode = {
      ...box(`pile:${stage}`, SIZE.pile, at(RING.pile, PILE_ANGLE[stage])),
      fade: 1,
      kind: "pile",
      stage,
      count: ids.length,
    };
    nodes.push(pile);
    edges.push({
      id: `fork:${pile.id}`,
      kind: "fork",
      source: "project",
      target: pile.id,
      moving: false,
      fade: 1,
    });
  }

  // The batches drawn: each fork's own, while it is in it, bounced out of it, or landing through it.
  const drawnBatches = new Map<
    string,
    { batch: FlowBatch; forks: string[]; piles: Set<PileStage> }
  >();
  for (const change of standing) {
    if (change.stage !== "batch" && change.stage !== "bounced" && change.stage !== "landed")
      continue;
    const batch = lastBatchOf(change.id, flow.batches.values());
    if (batch === undefined) continue;
    // A bounce at precheck, or out of a batch Keel later set aside, has no batch of its own to show.
    if (change.stage === "bounced" && batch.ended?.how !== "red") continue;
    const seen = drawnBatches.get(batch.id) ?? {
      batch,
      forks: [],
      piles: new Set<PileStage>(),
    };
    if (forkAngle.has(change.id)) seen.forks.push(change.id);
    // A batch in flight with a member not drawn on its own is drawn, joined from the queue's pile where there is one.
    else if (change.stage === "batch") {
      if (piled.has("queue")) seen.piles.add("queue");
    } else continue;
    drawnBatches.set(batch.id, seen);
  }
  for (const id of kept.batch.keys()) if (!drawnBatches.has(id)) kept.batch.delete(id);

  // A batch is numbered by the order Keel formed it in this log.
  const number = new Map([...flow.batches.keys()].map((id, index) => [id, index + 1]));
  const ordered = [...drawnBatches.values()].toSorted((a, b) => a.batch.formedT - b.batch.formedT);
  for (const { batch, forks, piles } of ordered) {
    let angle = kept.batch.get(batch.id);
    if (angle === undefined) {
      const wanted = meanAngle(
        forks.length > 0
          ? forks.map((id) => forkAngle.get(id) ?? 0)
          : [...piles].map((stage) => PILE_ANGLE[stage]),
      );
      // The free place on the ring nearest where its forks are.
      const used = [...kept.batch.values()];
      let best = wanted;
      let bestGap = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < BATCH_SLOTS; slot += 1) {
        const candidate = slotAngle(slot, BATCH_SLOTS);
        if (used.some((other) => gap(other, candidate) < TURN / BATCH_SLOTS / 2)) continue;
        const off = gap(candidate, wanted);
        if (off < bestGap) [best, bestGap] = [candidate, off];
      }
      angle = best;
      kept.batch.set(batch.id, angle);
    }
    const fades = batch.members.map((id) => {
      const change = flow.changes.get(id);
      return change === undefined ? 0 : Math.max(0, Math.min(1, fadeOf(change)));
    });
    const fade = Math.max(...fades, 0);
    const state = batchState(batch);
    const why = whyOf(batch, world);
    const node: BatchNode = {
      ...box(`batch:${batch.id}`, SIZE.batch, at(RING.batch, angle)),
      fade,
      kind: "batch",
      batchId: batch.id,
      label: `Batch ${number.get(batch.id) ?? 0}`,
      state,
      members: batch.members.length,
      formedT: batch.formedT,
      ...(batch.verifyingT === undefined ? {} : { verifyingT: batch.verifyingT }),
      ...(batch.ended === undefined ? {} : { endedT: batch.ended.t }),
      ...(why === undefined ? {} : { why }),
    };
    nodes.push(node);
    const going = batch.ended === undefined;
    for (const id of forks)
      edges.push({
        id: `join:${id}:${batch.id}`,
        kind: "join",
        source: `fork:${id}`,
        target: node.id,
        moving: going,
        fade,
      });
    for (const pile of piles)
      edges.push({
        id: `join:pile:${pile}:${batch.id}`,
        kind: "join",
        source: `pile:${pile}`,
        target: node.id,
        moving: going,
        fade,
      });
    // A batch formed on others still in flight rests on the last of them, so a run of batches reads as one line.
    const under = ordered.findLast(
      (other) =>
        other.batch.id !== batch.id &&
        other.batch.formedT < batch.formedT &&
        other.batch.members.some((id) => batch.predecessors.includes(id)),
    );
    if (under !== undefined)
      edges.push({
        id: `chain:${batch.id}:${under.batch.id}`,
        kind: "chain",
        source: node.id,
        target: `batch:${under.batch.id}`,
        moving: false,
        fade,
      });

    // The checks: each step Keel started, as its step events tell it; where it told none, what the verdict said of
    // each step, or one running while the batch verifies.
    const verdict =
      batch.ended?.verdictId === undefined ? undefined : world.verdicts.get(batch.ended.verdictId);
    const steps: Omit<CheckNode, keyof Placed | "kind">[] =
      batch.steps.length > 0
        ? stepChecksOf(batch, verdict, why)
        : verdict !== undefined
          ? checksOf(verdict)
          : batch.verifyingT !== undefined && batch.ended === undefined
            ? [{ name: "Checks", result: "running", since: batch.verifyingT }]
            : [];
    const checkIds: string[] = [];
    const span = steps.length - 1;
    const step = checkStep(angle);
    steps.forEach((check, index) => {
      const id = `check:${batch.id}:${check.name}`;
      checkIds.push(id);
      nodes.push({
        ...box(id, SIZE.check, at(RING.check, angle + (index - span / 2) * step)),
        fade,
        kind: "check",
        ...check,
      });
      edges.push({
        id: `test:${id}`,
        kind: "test",
        source: node.id,
        target: id,
        moving: check.result === "running",
        fade,
      });
    });

    // A preview Keel deployed of one of its changes.
    const preview = batch.members
      .map((id) => world.changes.get(id)?.preview)
      .find((each) => each !== undefined);
    let last = node.id;
    if (preview !== undefined) {
      const deploy: DeployNode = {
        ...box(`deploy:${batch.id}`, SIZE.deploy, at(RING.deploy, angle)),
        fade,
        kind: "deploy",
        url: preview.url,
        down: preview.down,
      };
      nodes.push(deploy);
      for (const from of checkIds.length > 0 ? checkIds : [node.id])
        edges.push({
          id: `ship:${from}`,
          kind: "ship",
          source: from,
          target: deploy.id,
          moving: false,
          fade,
        });
      last = deploy.id;
    }

    // Landed: back into the project.
    if (batch.members.some((id) => flow.changes.get(id)?.stage === "landed"))
      edges.push({
        id: `land:${batch.id}`,
        kind: "land",
        source: last,
        target: "project",
        moving: true,
        fade,
      });

    // Bounced: red from what failed back to each fork it bounced.
    const failed = nodes.filter(
      (each): each is CheckNode =>
        each.kind === "check" && each.result === "fail" && checkIds.includes(each.id),
    );
    for (const id of forks) {
      if (flow.changes.get(id)?.stage !== "bounced") continue;
      // To the fork and to the agents working on it: it is theirs to revise.
      const back = nodes.filter(
        (each) =>
          each.id === `fork:${id}` || (each.kind === "agent" && each.id.startsWith(`agent:${id}:`)),
      );
      for (const from of failed.length > 0 ? failed.map((each) => each.id) : [node.id])
        for (const to of back)
          edges.push({
            id: `fail:${from}:${to.id}`,
            kind: "fail",
            source: from,
            target: to.id,
            moving: true,
            fade: 1,
          });
    }
  }

  const failed = new Set(
    nodes.flatMap((node) => (node.kind === "batch" && node.state === "red" ? [node.batchId] : [])),
  );
  const runs = new Set<string>();
  for (const change of standing) {
    const run = world.changes.get(change.id)?.run;
    if (run !== undefined) runs.add(run.id);
  }
  return {
    nodes,
    edges,
    bounds: boundsOf(nodes),
    focus: boundsOf(nodes.filter((node) => inFocus(node, failed))),
    runs: runs.size,
  };
}

/** Whether the view fits a node: all but deploys and checks, save the checks of a batch that failed. */
function inFocus(node: GrowthNode, failed: ReadonlySet<string>): boolean {
  if (node.kind === "deploy") return false;
  if (node.kind !== "check") return true;
  return [...failed].some((batchId) => node.id.startsWith(`check:${batchId}:`));
}

/**
 * The checks a verdict names, each with what it came to. A verdict that names none (a batch Keel could not compose)
 * is one check failed in Keel's own words: the first word of its first line, and the whole of what it said.
 */
function checksOf(verdict: {
  outcome: string;
  evidence: readonly string[];
}): Omit<CheckNode, keyof Placed | "kind">[] {
  const steps = stepsOf(verdict.evidence).filter((step) => step.result !== "said");
  if (steps.length > 0)
    return steps.map((step) => ({ name: step.name, result: step.result, line: step.line }));
  const [first] = verdict.evidence;
  if (first === undefined || verdict.outcome === "land") return [];
  return [
    { name: first.split(":")[0] ?? first, result: "fail", line: verdict.evidence.join("\n") },
  ];
}

/**
 * The checks of a batch Keel told step by step: each step it started, running from its start until it finished,
 * then what it came to and how long the runner took. A step still unfinished when the batch ended is stopped by
 * that end, in its words. A step the verdict names that never started is drawn from the verdict.
 */
function stepChecksOf(
  batch: FlowBatch,
  verdict: { evidence: readonly string[] } | undefined,
  why: string | undefined,
): Omit<CheckNode, keyof Placed | "kind">[] {
  const said = new Map(
    (verdict === undefined ? [] : stepsOf(verdict.evidence)).map((step) => [step.name, step]),
  );
  const checks = batch.steps.map((step): Omit<CheckNode, keyof Placed | "kind"> => {
    const { finished } = step;
    if (finished !== undefined) {
      const line =
        said.get(step.id)?.line ??
        (finished.failure === undefined
          ? undefined
          : `${step.id}: ${finished.outcome}, ${finished.failure}`);
      return {
        name: step.id,
        result: finished.outcome,
        took: finished.durationMs,
        ...(line === undefined ? {} : { line }),
      };
    }
    if (batch.ended !== undefined)
      return { name: step.id, result: "stopped", ...(why === undefined ? {} : { line: why }) };
    return { name: step.id, result: "running", since: step.startedT };
  });
  const started = new Set(batch.steps.map((step) => step.id));
  for (const step of said.values())
    if (step.result !== "said" && !started.has(step.name))
      checks.push({ name: step.name, result: step.result, line: step.line });
  return checks;
}

/** How far apart a batch's checks are on their ring at this angle: enough that their chips do not touch. */
function checkStep(angle: number): number {
  const dx = Math.abs(STRETCH * RING.check * Math.sin(angle));
  const dy = Math.abs(RING.check * Math.cos(angle));
  return Math.min(
    (SIZE.check.w + 14) / Math.max(dx, 1e-6),
    (SIZE.check.h + 10) / Math.max(dy, 1e-6),
  );
}
