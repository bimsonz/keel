import { describe, expect, it } from "vitest";
import type { VerdictView } from "../../../src/contract/keel/index.ts";
import { changePageOf } from "../../../src/engine/select.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { showing } from "../showing.ts";

/** Scenario 2's careless change, bounced on its batch's verdict, and its page as each view of that verdict draws it. */
async function careless() {
  const source = createMockSource({ scenario: "s2", seed: 42 });
  const player = showing(source);
  await player.load();
  player.seek(player.end);
  const change = [...player.world.changes.values()].find((held) => held.label === "#1205");
  const verdictId = change?.verdictIds.at(-1);
  if (change === undefined || verdictId === undefined)
    throw new Error("scenario 2 bounces no #1205");
  const view = await source.getVerdict(verdictId);
  const read = (served: VerdictView) =>
    changePageOf(player.world, change.id, {
      probes: new Map(),
      diffs: new Map(),
      verdicts: new Map([[verdictId, served]]),
      lattices: new Map(),
      refused: new Set<string>(),
    })?.verdict;
  return { view, read };
}

describe("the plan a verdict was issued under, from Keel's view of the verdict", () => {
  it("[plan.own] says whether the plan is the one Keel compiled for the change, by its hash", async () => {
    const { view, read } = await careless();
    expect(read(view)?.plan?.own).toBe(true);
    const other = { ...view, plan: { hash: "plan:another", steps: view.plan?.steps ?? [] } };
    expect(read(other)?.plan).toMatchObject({ hash: "plan:another", own: false });
  });

  it("[plan.unnamed] lists a line that names no step among the evidence by its class, and under no step", async () => {
    const { view, read } = await careless();
    const line = "evidence missing: sha256:0d1e";
    const verdict = read({ ...view, reasons: [...view.reasons, { line, class: "proof" }] });
    expect(verdict?.evidence.map((item) => [item.summary, item.class])).toEqual([[line, "proof"]]);
    expect(verdict?.plan?.steps.flatMap((step) => step.lines)).not.toContain(line);
  });

  it("[plan.none] has no plan where Keel's view gives none, and lists every line by its class", async () => {
    const { view, read } = await careless();
    const { plan: _plan, ...unplanned } = view;
    // With no plan, Keel names no step for any line.
    const verdict = read({
      ...unplanned,
      reasons: view.reasons.map(({ line }) => ({ line, class: "proof" as const })),
    });
    expect(verdict?.plan).toBeUndefined();
    expect(verdict?.evidence.map((item) => item.summary)).toEqual(
      view.reasons.map((reason) => reason.line),
    );
  });
});
