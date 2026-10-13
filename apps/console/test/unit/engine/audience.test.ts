import { describe, expect, it } from "vitest";
import type { ProjectView } from "../../../src/contract/keel/index.ts";
import { publicOnly, shownAgent } from "../../../src/engine/audience.ts";
import { funnelOf } from "../../../src/engine/funnel.ts";
import { World } from "../../../src/engine/world.ts";

const project: ProjectView = {
  id: "prj_1",
  namespace: { handle: "acme", kind: "org" },
  name: "demo",
  visibility: "public",
};

/** The funnel's last stage, where a person is asked, on a log that holds nothing yet. */
const stage = (people: boolean) =>
  funnelOf(new World(), people).rows.find((row) => row.stage === 5);

describe("who Keel reads a project's log to", () => {
  it("[audience.public] takes a reader Keel names no member to be read the public part alone, signed in or not", () => {
    expect(publicOnly({ mode: "live", project })).toBe(true);
    for (const role of ["owner", "maintainer", "member"] as const)
      expect(publicOnly({ mode: "live", project: { ...project, viewer: { role } } })).toBe(false);
    // A test fixture's log is whole.
    expect(publicOnly({ mode: "fixture", project })).toBe(false);
  });

  it("[audience.agent] shows an agent Keel has not named to this reader as unnamed, and never as a kind nobody said it was", () => {
    expect(shownAgent(undefined)).toEqual({ label: "Agent", class: "unnamed", harness: "" });
    const world = new World();
    world.apply(
      {
        eventId: "evt_1",
        type: "AgentEnrolled",
        entity: { kind: "agent", id: "agt_1" },
        seq: 1,
        at: "2026-10-12T09:00:00.000Z",
        payload: {
          _tag: "AgentEnrolled",
          agentId: "agt_1",
          projectId: project.id,
          name: "claude-ada",
          kind: "interactive",
          scopes: ["agent:work"],
        },
      },
      0,
    );
    expect(shownAgent(world.agents.get("agt_1"))).toEqual({
      label: "claude-ada",
      class: "real",
      harness: "",
    });
  });

  it("[audience.funnel] leaves the stage where a person is asked uncounted for a reader who is not shown the questions", () => {
    expect(stage(true)).toMatchObject({ reported: true, reached: 0 });
    expect(stage(false)).toMatchObject({ reported: false });
  });
});
