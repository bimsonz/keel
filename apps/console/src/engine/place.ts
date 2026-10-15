// Where each thing stands on the Pipeline. Columns have fixed
// places, left to right in the order a change goes through Keel. In each, what
// is there stands in the order it came, as a queue does: when the one ahead
// goes, the rest move up, and the view slides them there rather than jumping.
// So a column never has a gap, and what came last is at its foot.

import {
  BATCHES_COMPACT_AT,
  type Canvas,
  type CanvasBatch,
  CHIP_STAGES,
  type ChipStage,
  MEMBERS_SHOWN,
} from "./canvas.ts";

export type ColumnId = ChipStage | "agents" | "batches" | "verify" | "trunk";

export interface Column {
  id: ColumnId;
  title: string;
  x: number;
  width: number;
}

export const CHIP_W = 220;
/** A dotted column: a dot's pitch, how many to a row, and how far down the first row is. */
export const DOT = 14;
export const DOTS_PER_ROW = Math.floor(CHIP_W / DOT);
export const DOTS_TOP = 4;
export const CHIP_H = 74;
const CHIP_PITCH = CHIP_H + 12;
export const MEMBER_W = 176;
export const MEMBER_H = 50;
const MEMBER_GAP = 8;
export const BATCH_W = MEMBER_W * 2 + MEMBER_GAP + 24;
const BATCH_HEAD = 40;
const BATCH_GAP = 20;
export const COMPACT_H = 44;
export const AGENT_W = 232;
const AGENT_HEAD = 52;
export const RUN_H = 26;
const AGENT_GAP = 14;
export const COMMIT_H = 58;
const COMMIT_GAP = 10;
const GAP = 40;

/** The columns, left to right. */
export const COLUMNS: readonly Column[] = (() => {
  const order: [ColumnId, string, number][] = [
    ["agents", "Agents", AGENT_W],
    ["bounced", "Bounced", CHIP_W],
    ["declared", "Declared", CHIP_W],
    ["precheck", "Precheck", CHIP_W],
    ["queue", "Queue", CHIP_W],
    ["batches", "Batches in flight", BATCH_W],
    ["verify", "Verify", 240],
    ["trunk", "Trunk", 220],
  ];
  let x = 0;
  return order.map(([id, title, width]) => {
    const column = { id, title, x, width };
    x += width + GAP;
    return column;
  });
})();

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every column's id is in COLUMNS, by its type
export const COLUMN = Object.fromEntries(COLUMNS.map((column) => [column.id, column])) as Record<
  ColumnId,
  Column
>;

/** The whole canvas's width. */
export const CANVAS_W = (COLUMNS.at(-1)?.x ?? 0) + (COLUMNS.at(-1)?.width ?? 0);

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placed {
  /** Each change's box, in its column or in its batch. */
  changes: Map<string, Box>;
  agents: Map<string, Box>;
  /** Each run's row in its agent's box, by `agentId run.id`, and an agent's own where it names no run. */
  runs: Map<string, Box>;
  batches: Map<string, Box>;
  verify: Map<string, Box>;
  commits: Map<number, Box>;
  /** How far down anything reaches. */
  height: number;
}

export function batchHeight(batch: CanvasBatch, compact: boolean): number {
  if (compact) return COMPACT_H;
  const shown = Math.min(batch.shown.length, MEMBERS_SHOWN);
  const lines = Math.max(1, Math.ceil(shown / 2));
  return BATCH_HEAD + lines * (MEMBER_H + MEMBER_GAP) + (batch.more > 0 ? 22 : 0) + 4;
}

export function agentHeight(runs: number, more: boolean): number {
  return AGENT_HEAD + runs * RUN_H + (more ? RUN_H : 0) + 6;
}

/** Where everything stands. */
export function place(canvas: Canvas): Placed {
  const changes = new Map<string, Box>();
  let height = 0;
  for (const stage of CHIP_STAGES) {
    const { x } = COLUMN[stage];
    const dotted = canvas.dotted.includes(stage);
    canvas.changes
      .filter((change) => change.stage === stage)
      .toSorted((a, b) => a.since - b.since || a.id.localeCompare(b.id))
      .forEach((change, row) => {
        // A dotted column has a dot for each change, row by row, under its count.
        const box = dotted
          ? {
              x: x + (row % DOTS_PER_ROW) * DOT,
              y: DOTS_TOP + Math.floor(row / DOTS_PER_ROW) * DOT,
              width: DOT - 3,
              height: DOT - 3,
            }
          : { x, y: row * CHIP_PITCH, width: CHIP_W, height: CHIP_H };
        changes.set(change.id, box);
        height = Math.max(height, box.y + box.height);
      });
  }

  const agents = new Map<string, Box>();
  const runs = new Map<string, Box>();
  let y = 0;
  for (const agent of canvas.agents) {
    const tall = agentHeight(agent.runs.length, agent.moreRuns > 0);
    const box = { x: COLUMN.agents.x, y, width: AGENT_W, height: tall };
    agents.set(agent.id, box);
    runs.set(agent.id, { x: box.x, y, width: AGENT_W, height: AGENT_HEAD });
    agent.runs.forEach((run, index) => {
      runs.set(`${agent.id} ${run.id}`, {
        x: box.x,
        y: y + AGENT_HEAD + index * RUN_H,
        width: AGENT_W,
        height: RUN_H,
      });
    });
    y += tall + AGENT_GAP;
  }
  height = Math.max(height, y);

  const batches = new Map<string, Box>();
  const verify = new Map<string, Box>();
  const compact = canvas.batches.length > BATCHES_COMPACT_AT;
  y = 0;
  for (const batch of canvas.batches) {
    const tall = batchHeight(batch, compact);
    batches.set(batch.id, { x: COLUMN.batches.x, y, width: BATCH_W, height: tall });
    verify.set(batch.id, { x: COLUMN.verify.x, y, width: COLUMN.verify.width, height: tall });
    if (!compact)
      batch.shown.forEach((id, index) => {
        changes.set(id, {
          x: COLUMN.batches.x + 12 + (index % 2) * (MEMBER_W + MEMBER_GAP),
          y: y + BATCH_HEAD + Math.floor(index / 2) * (MEMBER_H + MEMBER_GAP),
          width: MEMBER_W,
          height: MEMBER_H,
        });
      });
    y += tall + BATCH_GAP;
  }
  height = Math.max(height, y);

  const commits = new Map<number, Box>();
  y = 0;
  for (const commit of canvas.commits) {
    commits.set(commit.height, {
      x: COLUMN.trunk.x,
      y,
      width: COLUMN.trunk.width,
      height: COMMIT_H,
    });
    y += COMMIT_H + COMMIT_GAP;
  }
  height = Math.max(height, y);
  return { changes, agents, runs, batches, verify, commits, height };
}
