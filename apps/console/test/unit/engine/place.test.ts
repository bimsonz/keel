import { describe, expect, it } from "vitest";
import { BATCHES_COMPACT_AT, COLUMN_DENSE_AT, canvasOf } from "../../../src/engine/canvas.ts";
import {
  type Box,
  CANVAS_W,
  CHIP_W,
  COLUMN,
  COLUMNS,
  COMPACT_H,
  DOT,
  DOTS_PER_ROW,
  RUN_H,
  agentHeight,
  place,
} from "../../../src/engine/place.ts";
import { Hand } from "../../fixtures/pipeline.ts";

const ids = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, index) => `${prefix}_${index + 1}`);

const overlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** Every pair of boxes that overlap, by their names. */
function overlapping(boxes: ReadonlyMap<string, Box>): string[] {
  const entries = [...boxes];
  return entries.flatMap(([a, boxA], index) =>
    entries.slice(index + 1).flatMap(([b, boxB]) => (overlap(boxA, boxB) ? [`${a} ${b}`] : [])),
  );
}

describe("the Pipeline's columns", () => {
  it("[place.columns] stand left to right in the order a change goes through Keel, none over the next", () => {
    expect(COLUMNS.map((column) => column.id)).toEqual([
      "agents",
      "bounced",
      "declared",
      "precheck",
      "queue",
      "batches",
      "verify",
      "trunk",
    ]);
    const crowded = COLUMNS.slice(1).filter((column, index) => {
      const before = COLUMNS[index];
      return before === undefined || column.x <= before.x + before.width;
    });
    expect(crowded).toEqual([]);
    expect(COLUMNS[0]?.x).toBe(0);
    const last = COLUMNS.at(-1);
    expect(CANVAS_W).toBe((last?.x ?? 0) + (last?.width ?? 0));
  });
});

describe("where each thing stands", () => {
  it("[place.stack] stacks a column's changes in the order they came into its stage, with no gap and none over another", () => {
    // Declared in one order, queued in another; two came into the queue in the same second.
    const hand = new Hand().at(1);
    for (const id of ["chg_c", "chg_a", "chg_b", "chg_e", "chg_d"])
      hand.declare(id).start(id).submit(id);
    hand
      .at(10)
      .queue("chg_a")
      .at(20)
      .queue("chg_b")
      .at(30)
      .queue("chg_c")
      .at(40)
      .queue("chg_e")
      .queue("chg_d");
    const canvas = canvasOf(hand.world(), 50_000);
    const placed = place(canvas);
    const queue = [...placed.changes].filter(([, box]) => box.x === COLUMN.queue.x);
    expect(queue.toSorted(([, a], [, b]) => a.y - b.y).map(([id]) => id)).toEqual([
      "chg_a",
      "chg_b",
      "chg_c",
      "chg_d",
      "chg_e",
    ]);
    expect(queue.every(([, box]) => box.width === CHIP_W)).toBe(true);
    expect(queue.map(([, box]) => box.y).toSorted((a, b) => a - b)[0]).toBe(0);
    expect(overlapping(placed.changes)).toEqual([]);
    expect(Math.max(...queue.map(([, box]) => box.y + box.height))).toBeLessThanOrEqual(
      placed.height,
    );
  });

  it("[place.dots] draws a dotted column a dot a change, row by row in the order they came, inside the column", () => {
    const hand = new Hand().at(1);
    const queued = ids("chg_q", COLUMN_DENSE_AT + 1);
    queued.forEach((id, index) => hand.at(1 + index).queued([id]));
    hand.at(1).declare("chg_p").submit("chg_p");
    const canvas = canvasOf(hand.world(), 60_000);
    expect(canvas.dotted).toEqual(["queue"]);
    const placed = place(canvas);
    const dots = queued.map((id) => placed.changes.get(id));
    const column = { x: COLUMN.queue.x, y: 0, width: CHIP_W, height: placed.height };
    expect(dots.filter((dot) => dot === undefined || !inside(dot, column))).toEqual([]);
    expect(overlapping(placed.changes)).toEqual([]);
    // The first to come is at the top left; a row holds DOTS_PER_ROW, and the next starts under it.
    expect(dots[0]).toMatchObject({ x: COLUMN.queue.x, width: DOT - 3, height: DOT - 3 });
    expect(dots[DOTS_PER_ROW]).toMatchObject({ x: COLUMN.queue.x, y: (dots[0]?.y ?? 0) + DOT });
    expect(dots[DOTS_PER_ROW - 1]?.y).toBe(dots[0]?.y);
    // The column under its threshold is still drawn a chip a change.
    expect(placed.changes.get("chg_p")).toMatchObject({ x: COLUMN.precheck.x, width: CHIP_W });
  });

  it("[place.batches] stacks the batches in flight, each change of one inside its box, and its verification beside it", () => {
    const hand = new Hand().at(1);
    const three = ids("chg_a", 3);
    const nine = ids("chg_b", 9);
    hand.queued([...three, ...nine, "chg_c_1"]);
    hand.at(2).form("bat_3", three).form("bat_9", nine).form("bat_1", ["chg_c_1"]);
    const canvas = canvasOf(hand.world(), 3000);
    const placed = place(canvas);
    expect(canvas.batches.map((batch) => batch.shown.length)).toEqual([3, 8, 1]);
    const outside = canvas.batches.flatMap((batch) => {
      const box = placed.batches.get(batch.id);
      return batch.shown.filter((id) => {
        const member = placed.changes.get(id);
        return box === undefined || member === undefined || !inside(member, box);
      });
    });
    expect(outside).toEqual([]);
    expect(placed.batches.size).toBe(3);
    const beside = canvas.batches.map((batch) => {
      const box = placed.batches.get(batch.id);
      return box === undefined
        ? undefined
        : { x: COLUMN.verify.x, y: box.y, width: COLUMN.verify.width, height: box.height };
    });
    expect(canvas.batches.map((batch) => placed.verify.get(batch.id))).toEqual(beside);
    // Eight of nine are drawn; the ninth is counted.
    expect(placed.changes.has("chg_b_9")).toBe(false);
    expect(overlapping(placed.batches)).toEqual([]);
    expect(overlapping(placed.changes)).toEqual([]);
  });

  it("[place.compact] draws each batch as one short row past BATCHES_COMPACT_AT, with no change drawn inside", () => {
    const hand = new Hand().at(1);
    const members = ids("chg", BATCHES_COMPACT_AT + 1);
    hand.queued(members).at(2);
    for (const id of members) hand.form(`bat_${id}`, [id]);
    const placed = place(canvasOf(hand.world(), 3000));
    expect([...placed.batches.values()].map((box) => box.height)).toEqual(
      members.map(() => COMPACT_H),
    );
    expect(members.filter((id) => placed.changes.has(id))).toEqual([]);
    expect(overlapping(placed.batches)).toEqual([]);
  });

  it("[place.agents] stacks the agents, each run's row inside its agent, and a row for the runs not listed", () => {
    const hand = new Hand().at(1).enrol("agt_many", "Many").enrol("agt_one", "One");
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9])
      hand
        .runOf("agt_many", { id: `run_${n}`, label: `run ${n}` })
        .declare(`chg_m${n}`, { agentId: "agt_many" });
    hand.declare("chg_o", { agentId: "agt_one" });
    const canvas = canvasOf(hand.world(), 2000);
    const placed = place(canvas);
    const many = placed.agents.get("agt_many");
    const one = placed.agents.get("agt_one");
    expect(many?.height).toBe(agentHeight(8, true));
    expect(one?.height).toBe(agentHeight(0, false));
    expect(agentHeight(8, true) - agentHeight(8, false)).toBe(RUN_H);
    const rows = [...placed.runs].filter(([key]) => key.startsWith("agt_many "));
    expect(rows).toHaveLength(8);
    expect(rows.filter(([, row]) => many === undefined || !inside(row, many))).toEqual([]);
    expect(overlapping(new Map(rows))).toEqual([]);
    expect(overlapping(placed.agents)).toEqual([]);
  });
});
