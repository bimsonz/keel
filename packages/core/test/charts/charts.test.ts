import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AnyStateNode, createMachine } from "xstate";
import { type Chart, edgesOf, leavesOf, statesOf, terminalsOf, toMermaid } from "./chart-kit.ts";
import { charts } from "./charts.ts";
import { DOC, renderDocs } from "./render.ts";

const nodesOf = (node: AnyStateNode): AnyStateNode[] => [
  node,
  ...Object.values(node.states).flatMap(nodesOf),
];

/** The chart as xstate builds it: its state ids, and the id of every state an initial or a transition targets. */
const built = (chart: Chart) => {
  const nodes = nodesOf(createMachine(chart).root);
  return {
    states: nodes.map((n) => n.id),
    // xstate resolves a node's initial and transitions when they are read: an unknown target throws here.
    targets: nodes.flatMap((n) => [
      ...n.initial.target.map((t) => t.id),
      ...[...n.transitions.values()].flat().flatMap((t) => (t.target ?? []).map((x) => x.id)),
    ]),
  };
};

describe("the statecharts", () => {
  it("[charts.docs-match] every diagram in state-machines.md is drawn from its chart", () => {
    const doc = readFileSync(DOC, "utf8");
    // Each chart's block is in the doc, and nothing in it differs from what the chart draws.
    for (const chart of charts) expect(doc).toContain(toMermaid(chart));
    expect(renderDocs(doc)).toBe(doc);
  });

  it("[charts.well-formed] every edge leads to a state the chart has, and every leaf is reachable or terminal", () => {
    for (const chart of charts) {
      const leaves = new Set(leavesOf(chart));
      const edges = edgesOf(chart);
      expect(
        edges
          .filter((e) => !leaves.has(e.to))
          .map((e) => `${chart.id}: ${e.from} --${e.event}--> ${e.to}`),
      ).toEqual([]);
      const reached = new Set([
        chart.initial,
        ...(chart.meta.alsoCreated ?? []).map((c) => c.target),
        ...edges.map((e) => e.to),
      ]);
      expect(
        [...leaves].filter((l) => !reached.has(l) && !l.startsWith(`${chart.initial}.`)),
      ).toEqual([]);
      expect(terminalsOf(chart).every((t) => leaves.has(t))).toBe(true);
    }
  });

  it("[charts.valid] xstate builds every chart: each state it holds is a state of the chart, and every initial and transition resolves", () => {
    for (const chart of charts) {
      const machine = built(chart);
      expect(machine.states).toEqual([
        chart.id,
        ...statesOf(chart).map(([p]) => `${chart.id}.${p}`),
      ]);
      expect(machine.targets.filter((t) => !machine.states.includes(t))).toEqual([]);
    }
  });
});
