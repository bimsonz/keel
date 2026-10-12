import { describe, expect, it, vi } from "vitest";
import { createRng } from "../../fixtures/prng.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import {
  NO_SUBJECT,
  type GraphNode,
  type LaneOptions,
  type Lanes,
  lanesOf,
} from "../../../src/engine/lanes.ts";
import { openCounts } from "../../../src/engine/lists.ts";
import { World } from "../../../src/engine/world.ts";
import { declareChange, foldedLog, openingOf, premiseOn } from "./script.ts";
import { showing } from "../showing.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

async function worldAt(
  scenario: "s1" | "s2" | "swarm",
  seconds: number,
  ruling?: string,
): Promise<{ world: World; t: number }> {
  const player = showing(
    createMockSource({ scenario, seed: 42, ...(ruling === undefined ? {} : { ruling }) }),
  );
  await player.load();
  player.seek(seconds * 1000);
  return { world: player.world, t: player.t };
}

async function lanesAt(
  scenario: "s1" | "s2" | "swarm",
  seconds: number,
  ruling?: string,
  options?: LaneOptions,
): Promise<Lanes> {
  const { world, t } = await worldAt(scenario, seconds, ruling);
  return lanesOf(world, t, options);
}

const nodesOf = (lanes: Lanes): GraphNode[] => lanes.lanes.flatMap((lane) => lane.nodes);

/** How many nodes of each kind are drawn, e.g. "agent 2, change 2, subject 1". */
function census(lanes: Lanes): string {
  const counts = new Map<string, number>();
  for (const node of nodesOf(lanes)) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return [...counts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
}

const holds = (lanes: Lanes): string[] =>
  nodesOf(lanes).flatMap((node) =>
    node.kind === "change" && node.holds !== undefined ? [node.holds.text] : [],
  );

/** The lanes' subjects, in the order Mission Control gives them a minute in. */
const order = (world: World): string[] => lanesOf(world, 60_000).lanes.map((lane) => lane.key);

describe("Mission Control's lanes follow what is happening", () => {
  it("has no lane before anyone declares", async () => {
    expect((await lanesAt("s1", 20)).lanes).toEqual([]);
  });

  it("gains a lane for the subject, with the change and its agent, when an intent is declared", async () => {
    const lanes = await lanesAt("s1", 40);
    expect(lanes.lanes.map((lane) => [lane.key, lane.open, lane.changes])).toEqual([
      ["authz.permission-evaluation", true, 1],
    ]);
    expect(census(lanes)).toBe("agent 1, change 1, subject 1");
    // What the change holds about its subject is said on the change, not on a line.
    expect(holds(lanes)).toEqual(["relies on: is unchanged"]);
  });

  it("shows both changes in the one subject's lane, each with what it holds", async () => {
    const lanes = await lanesAt("s1", 380);
    expect(lanes.lanes).toHaveLength(1);
    expect(census(lanes)).toBe("agent 2, change 2, subject 1");
    expect(holds(lanes).toSorted()).toEqual([
      "relies on: at most per-request",
      "relies on: is unchanged",
    ]);
  });

  it("opens the conflict in the lane when the derived effect contradicts the premise", async () => {
    const lanes = await lanesAt("s1", 400);
    expect(census(lanes)).toBe("agent 2, change 2, conflict 1, subject 1");
    const altering = nodesOf(lanes).find(
      (node) => node.kind === "change" && node.holds?.derived === true,
    );
    expect(altering).toMatchObject({ holds: { text: "alters: is per-session", derived: true } });
    expect(lanes.lanes[0]?.edges.find((edge) => edge.derived === true)).toMatchObject({
      from: altering?.id,
      tone: "proven",
    });
    expect(lanes.lanes[0]).toMatchObject({ conflicts: 1, subject: { tone: "suspected" } });
  });

  it("[lanes.probe-record] carries the world matrix inside the probe, filling run by run, and says no run is running", async () => {
    const probe = nodesOf(await lanesAt("s1", 443)).find((node) => node.kind === "probe");
    expect(probe).toMatchObject({ label: "P-1", state: "calibrating" });
    expect(probe?.kind === "probe" ? probe.runs : []).toEqual([
      ["trunk", ["n/a", "n/a", "n/a"]],
      // The control: A's world with what it relies on removed. The probe fails there, as it must.
      ["A-noop", ["fail", "fail", "fail"]],
      ["A", ["pass", "pass", "pass"]],
      ["B", ["n/a", "n/a", "n/a"]],
      // The third run is not in. Keel says nothing of a run before it has ended, so none is said to be running.
      ["AB", ["fail", "fail", "pending"]],
    ]);
  });

  it("adds the guard and the question once the conflict is proven, and marks the subject as waiting on a person", async () => {
    const lanes = await lanesAt("s1", 460, "live");
    expect(census(lanes)).toBe(
      "agent 2, change 2, conflict 1, escalation 1, guard 1, probe 1, subject 1",
    );
    expect(lanes.lanes[0]?.subject).toMatchObject({ tone: "person" });
    expect(nodesOf(lanes).find((node) => node.kind === "escalation")).toMatchObject({
      label: "E-1",
      state: "open",
      standing: "Both changes wait",
    });
  });

  it("says what was decided on the question it answered, not in a node of its own", async () => {
    // Ruled at 472 s; the conflict stays a moment so it is seen to settle.
    const lanes = await lanesAt("s1", 480);
    expect(census(lanes)).toContain("conflict 1");
    expect(census(lanes)).not.toContain("decision");
    expect(nodesOf(lanes).find((node) => node.kind === "escalation")).toMatchObject({
      state: "ruled",
      decision: { label: "D-1", chosen: "Cache allowed if revocation invalidates it" },
    });
  });

  it("does not bring a settled conflict back when its changes carry on", async () => {
    // B revises at 500 s and lands at 672 s: the conflict stays gone throughout.
    const later = await Promise.all([505, 600, 676].map((second) => lanesAt("s1", second)));
    expect(later.map(census).filter((kinds) => kinds.includes("conflict"))).toEqual([]);
  });

  it("lets the changes leave after they land, and keeps what the evidence earned in the subject's lane", async () => {
    const lanes = await lanesAt("s1", 760);
    expect(census(lanes)).toBe("decision 1, guard 1, subject 1");
    expect(lanes.lanes[0]).toMatchObject({
      changes: 0,
      conflicts: 0,
      subject: { tone: "pass", guards: 1, decisions: 1 },
    });
    // They stand in the lane of the subject they are about. No line is drawn across it to say so.
    expect(lanes.lanes[0]?.edges).toEqual([]);
  });

  it("draws every line to the right, and never out of its lane", async () => {
    const column: Record<GraphNode["kind"], number> = {
      agent: 0,
      change: 1,
      stack: 1,
      reference: 1,
      subject: 2,
      conflict: 3,
      probe: 4,
      escalation: 5,
      decision: 5,
      guard: 5,
    };
    const moments = await Promise.all(
      [40, 400, 443, 460, 480, 760].map((second) => lanesAt("s1", second)),
    );
    for (const lanes of [...moments, await lanesAt("swarm", 100)]) {
      for (const lane of lanes.lanes) {
        const kinds = new Map(lane.nodes.map((node) => [node.id, node.kind]));
        for (const edge of lane.edges) {
          const [from, to] = [kinds.get(edge.from), kinds.get(edge.to)];
          expect(
            from === undefined || to === undefined
              ? "an edge to a node outside its lane"
              : column[to] > column[from]
                ? "rightwards"
                : `${from} to ${to}`,
          ).toBe("rightwards");
        }
      }
      const ids = nodesOf(lanes).map((node) => node.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("Mission Control at the scale of a swarm", () => {
  it("puts first what a person is being asked about, then what is contested, and opens those lanes", async () => {
    const { world, t } = await worldAt("swarm", 100);
    const lanes = lanesOf(world, t);
    const open = [...world.conflicts.values()].filter(
      (conflict) => conflict.state !== "resolved" && conflict.state !== "dismissed",
    );
    expect(open.map((conflict) => `${conflict.label} ${conflict.state}`)).toEqual([
      "C-7 escalated",
      "C-13 probing",
      "C-14 probing",
      "C-15 probing",
      "C-16 suspected",
      "C-17 suspected",
    ]);
    expect(lanes.lanes[0]).toMatchObject({
      key: "storage.gc.safety",
      open: true,
      conflicts: 1,
      subject: { tone: "person", guards: 1 },
    });
    // The contested lanes lead, oldest conflict first, and each is open.
    const contested = lanes.lanes.filter((lane) => lane.conflicts > 0);
    expect(lanes.lanes.slice(0, contested.length)).toEqual(contested);
    expect(contested.every((lane) => lane.open)).toBe(true);
    // Every open conflict is drawn: none is folded away where it cannot be opened.
    expect(
      nodesOf(lanes)
        .flatMap((node) => (node.kind === "conflict" ? [node.label] : []))
        .toSorted(),
    ).toEqual(open.map((conflict) => conflict.label).toSorted());
    expect(lanes.more.conflicts).toBe(0);
    // A lane with nothing contested and no real session on it is one line, until someone opens it.
    const quiet = lanes.lanes.filter((lane) => !lane.open);
    expect(quiet.length).toBeGreaterThan(0);
    expect(
      quiet.every((lane) => lane.nodes.length === 0 && lane.edges.length === 0 && lane.changes > 0),
    ).toBe(true);
  });

  it("counts every change still going exactly once: drawn, stacked beside its subject, or on a lane not shown", async () => {
    const { world, t } = await worldAt("swarm", 100);
    const lanes = lanesOf(world, t);
    const live = [...world.changes.values()].filter(
      (change) => !["landed", "withdrawn", "superseded"].includes(change.state),
    ).length;
    expect(lanes.changes).toBe(live);
    expect(lanes.lanes.reduce((sum, lane) => sum + lane.changes, 0) + lanes.more.changes).toBe(
      live,
    );
    // What is counted as open here is what the Changes tab counts as open.
    expect(lanes.changes).toBe(openCounts(world).changes);
    // In an open lane, what is drawn one by one and what is stacked come to the lane's own count.
    for (const lane of lanes.lanes.filter((each) => each.open && each.subject !== undefined)) {
      const drawn = lane.nodes.filter((node) => node.kind === "change").length;
      const stacked = lane.nodes
        .flatMap((node) => (node.kind === "stack" ? node.count : []))
        .reduce((sum, count) => sum + count, 0);
      expect(`${lane.key}: ${drawn + stacked}`).toBe(`${lane.key}: ${lane.changes}`);
    }
    // The swarm is counted, and called what it is. It is not a node.
    expect(lanes.agents).toMatchObject({ hosted: 0, synthetic: 800 });
    expect(lanes.agents.real).toBeGreaterThan(0);
  });

  it("[lanes.no-subject] draws a change that has said nothing about a subject in a lane of its own, beside its agent", () => {
    const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(3));
    b.at(0).emit({
      type: "AgentEnrolled",
      entity: { kind: "agent", id: "agt_1" },
      payload: {
        agentId: "agt_1",
        projectId: "prj_1",
        name: "agent",
        kind: "hosted",
        scopes: ["agent:work"],
      },
    });
    b.emit({
      type: "SubjectMinted",
      entity: { kind: "subject", id: "sub_1" },
      payload: { subjectId: "sub_1", key: "s.x", anchors: [], gloss: "", mintedBy: "scan" },
    });
    const declare = (
      id: string,
      premises: { subject: string; predicate: "bound"; relation: "at-most"; value: string }[],
    ): void => {
      b.after(1).emit({
        type: "IntentDeclared",
        entity: { kind: "change", id },
        payload: {
          changeId: id,
          agentId: "agt_1",
          origin: "agent",
          revision: 1,
          goal: id,
          footprint: [],
          premises,
          leaseId: "l",
        },
      });
    };
    // One on a subject Keel has minted, one with no premise at all, and one whose subject Keel has not minted.
    declare("chg_1", [{ subject: "s.x", predicate: "bound", relation: "at-most", value: "tight" }]);
    declare("chg_2", []);
    declare("chg_3", [
      { subject: "s.unminted", predicate: "bound", relation: "at-most", value: "tight" },
    ]);
    const world = new World();
    const log = b.build();
    log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
    const lanes = lanesOf(world, 10_000);
    expect(lanes.changes).toBe(3);
    // The subject's lane, and after it the lane that is no subject's.
    expect(lanes.lanes.map((lane) => [lane.key, lane.changes, lane.open])).toEqual([
      ["s.x", 1, true],
      [NO_SUBJECT, 2, true],
    ]);
    const loose = lanes.lanes.at(-1);
    expect(loose?.subject).toBeUndefined();
    expect(
      loose?.nodes.map((node) => `${node.kind} ${"changeId" in node ? node.changeId : ""}`),
    ).toEqual(["change chg_2", "agent ", "change chg_3", "agent "]);
    // Each agent stands beside its own change, and nothing leads on from a change that is about no subject.
    expect(loose?.edges.map((edge) => `${edge.from} > ${edge.to}`)).toEqual([
      "agent:agt_1:chg_2 > change:chg_2",
      "agent:agt_1:chg_3 > change:chg_3",
    ]);
    // A reader may close it, and it then says how much is in it.
    const closed = lanesOf(world, 10_000, { closed: new Set([NO_SUBJECT]) }).lanes.at(-1);
    expect(closed).toMatchObject({ key: NO_SUBJECT, open: false, changes: 2, nodes: [] });
    // A log in which no change has said anything about a subject is all in that one lane: Keel at its first level.
    const bare = new World();
    for (const [index, event] of log.events.entries())
      if (
        event.type !== "SubjectMinted" &&
        !(event.type === "IntentDeclared" && event.payload.changeId === "chg_1")
      )
        bare.apply(event, log.eventTimes[index] ?? 0);
    expect(lanesOf(bare, 10_000).lanes.map((lane) => [lane.key, lane.changes])).toEqual([
      [NO_SUBJECT, 2],
    ]);
  });

  it("[lanes.asked-of-change] puts first the lane of a change a person is asked about, and hangs the question from the change", () => {
    const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(5));
    b.at(0).emit({
      type: "AgentEnrolled",
      entity: { kind: "agent", id: "agt_1" },
      payload: {
        agentId: "agt_1",
        projectId: "prj_1",
        name: "agent",
        kind: "hosted",
        scopes: ["agent:work"],
      },
    });
    for (const [id, key] of [
      ["sub_a", "s.a"],
      ["sub_b", "s.b"],
    ] as const)
      b.emit({
        type: "SubjectMinted",
        entity: { kind: "subject", id },
        payload: { subjectId: id, key, anchors: [], gloss: "", mintedBy: "scan" },
      });
    const declare = (id: string, subject: string | null): void => {
      b.after(1).emit({
        type: "IntentDeclared",
        entity: { kind: "change", id },
        payload: {
          changeId: id,
          agentId: "agt_1",
          origin: "agent",
          revision: 1,
          goal: id,
          footprint: [],
          premises:
            subject === null
              ? []
              : [{ subject, predicate: "bound", relation: "at-most", value: "tight" }],
          leaseId: "l",
        },
      });
    };
    declare("chg_a", "s.a");
    declare("chg_b", "s.b");
    declare("chg_loose", null);
    // A conflict is suspected on s.a: contested, and nobody is asked.
    b.after(1).emit({
      type: "ConflictSuspected",
      entity: { kind: "conflict", id: "cfl_1" },
      payload: {
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_a"],
        subjectId: "sub_a",
        predicate: "bound",
      },
    });
    const ask = (id: string, about: string): void => {
      b.after(1).emit({
        type: "EscalationRaised",
        entity: { kind: "escalation", id },
        payload: {
          escalationId: id,
          question: `May ${about} go on?`,
          options: [
            { id: "yes", label: "It may", consequence: "" },
            { id: "hold", label: "It waits", consequence: "" },
          ],
          about: { kind: "change", id: about },
          category: "permission-semantics",
          evidence: [],
          precedents: [],
          default: "hold",
        },
      });
    };
    const folded = (events: number): World => {
      const world = new World();
      const log = b.build();
      log.events
        .slice(0, events)
        .forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
      return world;
    };
    const before = b.build().events.length;
    // Nobody is asked yet: the contested subject first, the busy one after it, and last the lane of no subject.
    expect(order(folded(before))).toEqual(["s.a", "s.b", NO_SUBJECT]);

    // Keel asks a person about the change on s.b itself. No conflict stands between the two.
    ask("esc_1", "chg_b");
    const asked = lanesOf(folded(before + 1), 60_000);
    expect(asked.lanes.map((lane) => lane.key)).toEqual(["s.b", "s.a", NO_SUBJECT]);
    const [first] = asked.lanes;
    expect(first?.subject?.tone).toBe("person");
    expect(
      first?.nodes.flatMap((node) =>
        node.kind === "escalation" ? [[node.question, node.standing, node.state]] : [],
      ),
    ).toEqual([["May chg_b go on?", "It waits", "open"]]);
    expect(
      first?.edges.flatMap((edge) =>
        edge.to === "escalation:esc_1" ? [`${edge.from} > ${edge.to} ${edge.tone}`] : [],
      ),
    ).toEqual(["change:chg_b > escalation:esc_1 person"]);

    // And about the change that is on no subject: its lane comes first of all.
    ask("esc_2", "chg_loose");
    expect(order(folded(before + 2))).toEqual([NO_SUBJECT, "s.b", "s.a"]);

    // Answered, the question stays on its change and no longer puts the lane first.
    b.after(1).emit({
      type: "RulingGiven",
      entity: { kind: "escalation", id: "esc_1" },
      payload: { escalationId: "esc_1", option: "yes", by: "usr_1", rationale: "" },
    });
    const ruled = lanesOf(folded(before + 3), 60_000);
    expect(ruled.lanes.map((lane) => lane.key)).toEqual([NO_SUBJECT, "s.a", "s.b"]);
    expect(
      ruled.lanes
        .at(-1)
        ?.edges.flatMap((edge) => (edge.to === "escalation:esc_1" ? [edge.tone] : [])),
    ).toEqual(["plain"]);
  });

  it("always shows the lane of the subject a reader has open, however far down it comes", async () => {
    const { world, t } = await worldAt("swarm", 100);
    const all = lanesOf(world, t, { shown: 1000 });
    const far = all.lanes[10]?.key ?? "";
    const pinned = lanesOf(world, t, { shown: 3, pinned: far });
    expect(pinned.lanes.map((lane) => lane.key)).toEqual([
      ...all.lanes.slice(0, 3).map((lane) => lane.key),
      far,
    ]);
    expect(pinned.lanes.at(-1)).toMatchObject({ key: far, open: true });
    expect(pinned.more.lanes).toBe(all.lanes.length - 4);
    // One already shown stays where it is, and one Keel has not heard of adds nothing.
    const near = all.lanes[1]?.key ?? "";
    expect(lanesOf(world, t, { shown: 3, pinned: near }).lanes.map((lane) => lane.key)).toEqual(
      all.lanes.slice(0, 3).map((lane) => lane.key),
    );
    expect(lanesOf(world, t, { shown: 3, pinned: "no.such.subject" }).lanes).toHaveLength(3);
  });

  it("shows a page of lanes, says how many more there are, and opens or closes a lane when asked", async () => {
    const { world, t } = await worldAt("swarm", 100);
    const all = lanesOf(world, t, { shown: 1000 });
    const page = lanesOf(world, t, { shown: 5 });
    expect(page.lanes.map((lane) => lane.key)).toEqual(
      all.lanes.slice(0, 5).map((lane) => lane.key),
    );
    expect(page.more.lanes).toBe(all.lanes.length - 5);
    expect(page.more.changes).toBe(all.lanes.slice(5).reduce((sum, lane) => sum + lane.changes, 0));
    expect(page.more.conflicts).toBe(
      all.lanes.slice(5).reduce((sum, lane) => sum + lane.conflicts, 0),
    );

    const quiet = all.lanes.find((lane) => !lane.open);
    const opened = lanesOf(world, t, {
      shown: 1000,
      opened: new Set([quiet?.key ?? ""]),
    }).lanes.find((lane) => lane.key === quiet?.key);
    expect(opened).toMatchObject({ open: true, changes: quiet?.changes });
    expect(opened?.nodes.map((node) => node.kind).toSorted()).toEqual(["stack", "subject"]);
    const closed = lanesOf(world, t, { closed: new Set(["storage.gc.safety"]) }).lanes[0];
    expect(closed).toMatchObject({
      key: "storage.gc.safety",
      open: false,
      nodes: [],
      conflicts: 1,
    });
  });
});

const referencesIn = (lanes: Lanes, key: string): Extract<GraphNode, { kind: "reference" }>[] =>
  (lanes.lanes.find((lane) => lane.key === key)?.nodes ?? []).flatMap((node) =>
    node.kind === "reference" ? [node] : [],
  );

describe("a change that touches more than one subject", () => {
  it("[lanes.touched] shows it in the lane of each other subject it touches, and counts it once", () => {
    const b = openingOf(7, [["agt_1", "hosted"]], ["a", "b", "c"]);
    // One relies on `a`, and Keel reads off its diff that it alters `b` and `c`. The other relies on `b` and on `c`.
    declareChange(b, "chg_1", "agt_1", [premiseOn("a")]);
    declareChange(b, "chg_2", "agt_1", [premiseOn("b"), premiseOn("c")]);
    b.after(1).emit({
      type: "EffectsDerived",
      entity: { kind: "change", id: "chg_1" },
      payload: {
        changeId: "chg_1",
        revision: 1,
        effects: [
          {
            method: "extractor",
            evidenceClass: "ruling",
            declared: false,
            proposition: { ...premiseOn("b", "loose"), gloss: "" },
            anchors: [],
          },
          {
            method: "extractor",
            evidenceClass: "ruling",
            declared: false,
            proposition: { ...premiseOn("c", "slack"), gloss: "" },
            anchors: [],
          },
        ],
        derivationRef: "mfp:derivation:chg_1:1",
      },
    });
    // Keel suspects a conflict on `b` between the two, and names its sides: the one whose own lane is `a` makes
    // the effect, against the premise the other holds.
    b.after(1).emit({
      type: "ConflictSuspected",
      entity: { kind: "conflict", id: "cfl_1" },
      payload: {
        conflictId: "cfl_1",
        kind: "semantic",
        parties: ["chg_2", "chg_1"],
        subjectId: "sub_b",
        subjectKey: "b",
        predicate: "bound",
        premise: { holder: "chg_2", proposition: premiseOn("b") },
        effect: { changeId: "chg_1", proposition: premiseOn("b", "loose") },
      },
    });
    const lanes = lanesOf(foldedLog(b), 60_000);

    // The contested subject first. `c` has a lane though no change is its own: two that stand elsewhere touch it.
    expect(lanes.lanes.map((lane) => [lane.key, lane.changes, lane.references])).toEqual([
      ["b", 1, 1],
      ["a", 1, 0],
      ["c", 0, 2],
    ]);
    // Each change is counted once, in the lane of its first subject, and drawn once with its agent beside it.
    expect(lanes.changes).toBe(2);
    expect(
      lanes.lanes.map((lane) =>
        lane.nodes.flatMap((node) => (node.kind === "change" ? [node.changeId] : [])),
      ),
    ).toEqual([["chg_2"], ["chg_1"], []]);
    expect(nodesOf(lanes).filter((node) => node.kind === "agent")).toHaveLength(2);
    const ids = nodesOf(lanes).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);

    // In the conflict's lane the side that alters stands beside it, with what ties it to this subject.
    expect(referencesIn(lanes, "b")).toEqual([
      {
        id: "reference:chg_1:sub_b",
        kind: "reference",
        changeId: "chg_1",
        label: expect.any(String),
        state: expect.any(String),
        holds: { text: "alters: at most loose", derived: true },
        home: "a",
      },
    ]);
    expect(referencesIn(lanes, "c")).toMatchObject([
      {
        id: "reference:chg_1:sub_c",
        changeId: "chg_1",
        holds: { text: "alters: at most slack", derived: true },
        home: "a",
      },
      {
        id: "reference:chg_2:sub_c",
        changeId: "chg_2",
        holds: { text: "relies on: at most tight", derived: false },
        home: "b",
      },
    ]);
    expect(referencesIn(lanes, "a")).toEqual([]);
    // Each is tied to the subject of the lane it is shown in, as a change of that lane is. The conflict is on
    // `b`, so that is where the side that alters is marked, and not on `c`, which it alters uncontested.
    expect(
      lanes.lanes.flatMap((lane) =>
        lane.edges.flatMap((edge) =>
          edge.from.startsWith("reference:")
            ? [`${edge.from} > ${edge.to} ${edge.tone}${edge.derived === true ? " derived" : ""}`]
            : [],
        ),
      ),
    ).toEqual([
      "reference:chg_1:sub_b > subject:sub_b proven derived",
      "reference:chg_1:sub_c > subject:sub_c plain derived",
      "reference:chg_2:sub_c > subject:sub_c plain",
    ]);
    // A reader who closes a lane is still told what stands elsewhere and touches it.
    expect(lanesOf(foldedLog(b), 60_000, { closed: new Set(["c"]) }).lanes.at(-1)).toMatchObject({
      key: "c",
      open: false,
      changes: 0,
      references: 2,
      nodes: [],
    });
  });

  it("[lanes.touched-swarm] shows a swarm's ordinary change in its own lane only, and a real session's wherever it touches", () => {
    const b = openingOf(
      9,
      [
        ["agt_s", "synthetic"],
        ["agt_r", "interactive"],
      ],
      ["a", "b", "c", "d"],
    );
    // Fifteen of a swarm's changes on `a`. The first of them relies on `b` and on `c` as well.
    declareChange(b, "chg_0", "agt_s", [premiseOn("a"), premiseOn("b"), premiseOn("c")]);
    for (let n = 1; n < 15; n += 1) declareChange(b, `chg_${n}`, "agt_s", [premiseOn("a")]);
    // A real session's change relies on `c`, and on `d`.
    declareChange(b, "chg_r", "agt_r", [premiseOn("c"), premiseOn("d")]);
    const world = foldedLog(b);
    const lanes = lanesOf(world, 60_000);

    // Where a real session is working comes first, and `d` is such a place. `b` is touched only by an ordinary
    // change of the swarm, which is counted beside `a` and gives `b` no lane.
    expect(lanes.lanes.map((lane) => [lane.key, lane.open, lane.changes, lane.references])).toEqual(
      [
        ["c", true, 1, 0],
        ["d", true, 0, 1],
        ["a", false, 15, 0],
      ],
    );
    expect(referencesIn(lanes, "d")).toMatchObject([{ changeId: "chg_r", home: "c" }]);
    // The swarm's change that relies on `c` is not drawn there, where the real session's own change is.
    expect(lanes.lanes[0]?.nodes.map((node) => node.kind).toSorted()).toEqual([
      "agent",
      "change",
      "subject",
    ]);
    // Counted once, each of them.
    expect(lanes.changes).toBe(16);
    expect(lanes.lanes.reduce((sum, lane) => sum + lane.changes, 0) + lanes.more.changes).toBe(16);
    // Opened, the swarm's lane counts its changes beside the subject, and none of them is shown anywhere else.
    const opened = lanesOf(world, 60_000, { opened: new Set(["a"]) });
    expect(
      opened.lanes
        .at(-1)
        ?.nodes.map((node) => node.kind)
        .toSorted(),
    ).toEqual(["stack", "subject"]);
    expect(nodesOf(opened).filter((node) => node.kind === "reference")).toHaveLength(1);
  });
});
