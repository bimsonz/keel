import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { edgesOf, leavesOf, terminalsOf, toMermaid } from "./chart-kit.ts";
import { charts } from "./charts.ts";
import { DOC, renderDocs } from "./render.ts";

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
      const reached = new Set([chart.initial, ...edges.map((e) => e.to)]);
      expect(
        [...leaves].filter((l) => !reached.has(l) && !l.startsWith(`${chart.initial}.`)),
      ).toEqual([]);
      expect(terminalsOf(chart).every((t) => leaves.has(t))).toBe(true);
    }
  });
});
