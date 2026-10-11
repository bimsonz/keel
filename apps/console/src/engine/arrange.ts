// Where things stand in Mission Control. Each kind of thing has one column,
// whatever else is in its lane, so the picture reads the same way every time:
// who, what they are changing, what it is about, the disagreement, the proof,
// and what came of it. Lanes stand one under another in their order, a closed
// lane as one row. Positions depend only on what is there.

import type { GraphNode, GraphNodeKind, Lane } from "./lanes.ts";

/** The columns, left to right, by what stands in each. */
export const COLUMNS = ["Agent", "Change", "Subject", "Conflict", "Probe", "Outcome"] as const;

export const NODE_W = 232;
const COLUMN_GAP = 56;
/** Left of the first column: where a lane is opened and closed. */
export const GUTTER = 44;
/** Where each column starts. */
export const COLUMN_X: readonly number[] = COLUMNS.map(
  (_, index) => GUTTER + index * (NODE_W + COLUMN_GAP),
);
/** How wide the whole picture is, at life size. */
export const WORLD_W = GUTTER + COLUMNS.length * NODE_W + (COLUMNS.length - 1) * COLUMN_GAP + 24;

/** A closed lane: one row. */
export const ROW_H = 44;
/** Lanes touch: the rule between them is the top edge of each. */
export const LANE_GAP = 0;
/** Above and below what an open lane holds. */
const LANE_PAD = 18;
const NODE_GAP = 12;

export const HEIGHT: Record<GraphNodeKind, number> = {
  agent: 56,
  change: 104,
  stack: 78,
  subject: 96,
  conflict: 100,
  probe: 172,
  escalation: 124,
  decision: 82,
  guard: 58,
};

const COLUMN_OF: Record<GraphNodeKind, number> = {
  agent: 0,
  change: 1,
  stack: 1,
  subject: 2,
  conflict: 3,
  probe: 4,
  escalation: 5,
  decision: 5,
  guard: 5,
};

/** The column a kind of thing stands in. It is the same in every lane. */
export function columnOf(kind: GraphNodeKind): number {
  return COLUMN_OF[kind];
}

export interface Placed {
  /** The key of the lane it is in. */
  lane: string;
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A lane's own band of the picture. */
export interface Band {
  key: string;
  top: number;
  height: number;
  open: boolean;
}

const tall = (nodes: GraphNode[]): number =>
  nodes.reduce((sum, node) => sum + HEIGHT[node.kind], 0) +
  NODE_GAP * Math.max(0, nodes.length - 1);

export function arrange(lanes: Lane[]): { placed: Placed[]; bands: Band[]; height: number } {
  const placed: Placed[] = [];
  const bands: Band[] = [];
  let top = 0;
  for (const lane of lanes) {
    if (!lane.open) {
      bands.push({ key: lane.key, top, height: ROW_H, open: false });
      top += ROW_H + LANE_GAP;
      continue;
    }
    const columns = new Map<number, GraphNode[]>();
    for (const node of lane.nodes) {
      const column = columnOf(node.kind);
      columns.set(column, [...(columns.get(column) ?? []), node]);
    }
    const inner = Math.max(0, ...[...columns.values()].map(tall));
    const here = new Map<string, Placed>();
    for (const [column, nodes] of columns) {
      // An agent stands beside its change, not in a stack of its own: that is done below.
      if (column === 0) continue;
      let y = top + LANE_PAD + (inner - tall(nodes)) / 2;
      for (const node of nodes) {
        const at: Placed = {
          lane: lane.key,
          node,
          x: COLUMN_X[column] ?? 0,
          y,
          width: NODE_W,
          height: HEIGHT[node.kind],
        };
        here.set(node.id, at);
        placed.push(at);
        y += HEIGHT[node.kind] + NODE_GAP;
      }
    }
    for (const node of columns.get(0) ?? []) {
      const change = here.get(lane.edges.find((edge) => edge.from === node.id)?.to ?? "");
      const y =
        change === undefined ? top + LANE_PAD : change.y + (change.height - HEIGHT[node.kind]) / 2;
      placed.push({
        lane: lane.key,
        node,
        x: COLUMN_X[0] ?? 0,
        y,
        width: NODE_W,
        height: HEIGHT[node.kind],
      });
    }
    const height = inner + LANE_PAD * 2;
    bands.push({ key: lane.key, top, height, open: true });
    top += height + LANE_GAP;
  }
  const last = bands.at(-1);
  return { placed, bands, height: last === undefined ? 0 : last.top + last.height };
}

/** The size the picture is drawn at for a window this wide: life size where it fits, and never under four fifths of it. */
export function zoomFor(width: number): number {
  return Math.min(1, Math.max(0.8, width / WORLD_W));
}
