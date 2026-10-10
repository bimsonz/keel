/**
 * Draws docs/domain/state-machines.md's diagrams from the charts. Each
 * machine's mermaid block sits between `chart:<id>` markers in its section;
 * the first run puts the markers around the hand-drawn block it replaces.
 *
 *   node packages/core/test/charts/render.ts --write   rewrite the diagrams
 *   node packages/core/test/charts/render.ts --check   exit 1 if any is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Chart, toMermaid } from "./chart-kit.ts";
import { charts } from "./charts.ts";

export const DOC = join(import.meta.dirname, "../../../../docs/domain/state-machines.md");

const open = (chart: Chart) =>
  `<!-- chart:${chart.id} — generated from packages/core/test/charts/charts.ts by render.ts; edit the chart, not this block -->`;
const close = (chart: Chart) => `<!-- /chart:${chart.id} -->`;

const block = (chart: Chart): string =>
  `${open(chart)}\n\`\`\`mermaid\n${toMermaid(chart)}\n\`\`\`\n${close(chart)}`;

/** The doc with every chart's diagram drawn from its chart. */
export const renderDocs = (doc: string): string =>
  charts.reduce((text, chart) => {
    const marked = text.indexOf(`<!-- chart:${chart.id} `);
    if (marked !== -1) {
      const end = text.indexOf(close(chart), marked);
      if (end === -1) throw new Error(`chart:${chart.id} has no closing marker`);
      return text.slice(0, marked) + block(chart) + text.slice(end + close(chart).length);
    }
    const heading = new RegExp(`^#{2,3} ${chart.meta.section.replace(/[()]/g, "\\$&")}$`, "m").exec(
      text,
    );
    if (heading === null)
      throw new Error(`no section "${chart.meta.section}" for chart:${chart.id}`);
    const start = text.indexOf("```mermaid", heading.index);
    const end = text.indexOf("```", start + 3);
    if (start === -1 || end === -1)
      throw new Error(`no mermaid block in section "${chart.meta.section}"`);
    return text.slice(0, start) + block(chart) + text.slice(end + 3);
  }, doc);

if (import.meta.main) {
  const doc = readFileSync(DOC, "utf8");
  const rendered = renderDocs(doc);
  if (process.argv.includes("--write")) {
    writeFileSync(DOC, rendered);
    console.log(rendered === doc ? "diagrams already current" : "diagrams redrawn");
  } else if (rendered !== doc) {
    console.error(
      "state-machines.md's diagrams are stale: run node packages/core/test/charts/render.ts --write",
    );
    process.exit(1);
  }
}
