import { describe, expect, it, vi } from "vitest";
import {
  type Reference,
  laneName,
  piecesOf,
  referencesIn,
} from "../../../src/engine/references.ts";
import { type Resources, changePageOf } from "../../../src/engine/select.ts";
import { subjectDetailOf } from "../../../src/engine/subject.ts";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { showing } from "../showing.ts";
import { declareChange, foldedLog, openingOf, premiseOn } from "./script.ts";

// A test here replays a whole scenario. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const NOTHING: Resources = {
  probes: new Map(),
  diffs: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set(),
};

// Ids as Keel writes them: the kind's three letters, an underscore and a ULID.
const DECISION = "dec_2F82DH6DE0PGDTFTXNR1BZ3SXC";
const GUARD = "grd_01M4XFPMP316ARZSP9PVYD2R95";
const CHANGE = "chg_01M4XFPMP316ARZSP9PVYD2R96";

const KNOWN: ReadonlyMap<string, Reference> = new Map([
  [DECISION, { kind: "decision", id: DECISION, label: "D-1" }],
  [GUARD, { kind: "guard", id: GUARD, label: "G-1" }],
]);

/** A sentence as the page reads it: Keel's words, and each id it named by its label. */
const read = (pieces: ReturnType<typeof piecesOf>): string =>
  pieces.map((piece) => (typeof piece === "string" ? piece : `[${piece.label}]`)).join("");

describe("[references.lane] a lane is called by the name Keel gives it within its project", () => {
  it("names a lane Keel addresses as lane:<projectId>:<name> by its name", () => {
    expect(laneName("lane:prj_XAAYRVP8Z3HGSV7MH0N0XNBB01:main")).toBe("main");
    expect(laneName("lane:prj_XAAYRVP8Z3HGSV7MH0N0XNBB01:3")).toBe("3");
  });

  it("shows an id of any other form as Keel wrote it", () => {
    expect(laneName("lane-1")).toBe("lane-1");
    expect(laneName("lane:prj_XAAYRVP8Z3HGSV7MH0N0XNBB01")).toBe(
      "lane:prj_XAAYRVP8Z3HGSV7MH0N0XNBB01",
    );
  });

  it("calls a queued change's lane by its name on its page", () => {
    const b = openingOf(1, [["agt_a", "interactive"]], ["auth.cache"]);
    declareChange(b, "chg_a", "agt_a", [premiseOn("auth.cache")]);
    b.after(1).emit({
      type: "ChangeQueued",
      entity: { kind: "change", id: "chg_a" },
      payload: { changeId: "chg_a", laneId: "lane:prj_1:main" },
    });
    const world = foldedLog(b);
    expect(changePageOf(world, "chg_a", NOTHING)?.change.lane).toBe("main");
  });
});

describe("[references.pieces] Keel's sentences name things by id, and the page calls each by its label", () => {
  const sentence = `Fix the guarded behaviour, push, then submit again: guard:${GUARD} (freshness): subject GET /repos/owner/test -> 200 (expected 404); it holds decision ${DECISION}: The premise holds`;

  it("calls each id the log has a label for by that label, and keeps every other word as Keel wrote it", () => {
    expect(read(piecesOf(sentence, KNOWN))).toBe(
      "Fix the guarded behaviour, push, then submit again: guard:[G-1] (freshness): subject GET /repos/owner/test -> 200 (expected 404); it holds decision [D-1]: The premise holds",
    );
    expect(
      piecesOf(sentence, KNOWN).flatMap((piece) =>
        typeof piece === "string" ? [] : [[piece.kind, piece.id]],
      ),
    ).toEqual([
      ["guard", GUARD],
      ["decision", DECISION],
    ]);
  });

  it("leaves an id the log holds no label for as Keel wrote it", () => {
    const said = `Withdraw ${CHANGE} first.`;
    expect(piecesOf(said, KNOWN)).toEqual([said]);
  });

  it("leaves an id the log holds as another kind than its prefix says as Keel wrote it", () => {
    const said = `See ${DECISION}.`;
    const misfiled = new Map([[DECISION, { kind: "change" as const, id: DECISION, label: "#4" }]]);
    expect(piecesOf(said, misfiled)).toEqual([said]);
  });

  it("does not read an id out of a longer word", () => {
    const said = `x${DECISION} and ${DECISION}9`;
    expect(piecesOf(said, KNOWN)).toEqual([said]);
  });

  it("names an id each time it is written, each where it stands", () => {
    const pieces = piecesOf(`${DECISION} and ${DECISION}`, KNOWN);
    expect(read(pieces)).toBe("[D-1] and [D-1]");
    expect(pieces.flatMap((piece) => (typeof piece === "string" ? [] : [piece.at]))).toEqual([
      0,
      DECISION.length + 5,
    ]);
  });
});

describe("[references.known] every kind a sentence can name is known by the label Keel gave it", () => {
  it("knows each change, conflict, escalation, decision and guard of a project's log as its own kind", async () => {
    const player = showing(createMockSource({ scenario: "s2", seed: 42 }));
    await player.load();
    player.seek(player.end);
    const world = player.world;
    const known = referencesIn(world);
    const kinds = [
      ["change", world.changes],
      ["conflict", world.conflicts],
      ["escalation", world.escalations],
      ["decision", world.decisions],
      ["guard", world.guards],
    ] as const;
    for (const [kind, entries] of kinds) {
      expect(entries.size, `scenario 2 has a ${kind}`).toBeGreaterThan(0);
      for (const entry of entries.values())
        expect(known.get(entry.id)).toEqual({ kind, id: entry.id, label: entry.label });
    }
  });
});

const glossed = (gloss: string) => {
  const b = openingOf(2, [["agt_a", "interactive"]], []);
  const minted: [string, string][] = [
    ["auth.cache", gloss],
    ["auth.roles", "Who may do what"],
  ];
  for (const [key, said] of minted)
    b.emit({
      type: "SubjectMinted",
      entity: { kind: "subject", id: `sub_${key}` },
      payload: { subjectId: `sub_${key}`, key, anchors: [], gloss: said, mintedBy: "agent" },
    });
  declareChange(b, "chg_a", "agt_a", [premiseOn("auth.cache"), premiseOn("auth.roles")]);
  return foldedLog(b);
};
/** Each subject's key and its gloss, as its panel beside Mission Control says them. */
const subjectsOf = (world: ReturnType<typeof glossed>) =>
  ["auth.cache", "auth.roles"].map((key) => [key, subjectDetailOf(world, key)?.gloss]);

describe("[references.gloss] a subject's gloss is drawn only where it says more than its key", () => {
  it("draws no gloss where Keel glossed a subject with its key", () => {
    const world = glossed("auth.cache");
    expect(subjectsOf(world)).toContainEqual(["auth.cache", ""]);
    expect(subjectDetailOf(world, "auth.cache")?.gloss).toBe("");
  });

  it("draws a gloss that says more than the key", () => {
    const world = glossed("Roles a session has cached");
    expect(subjectsOf(world)).toContainEqual(["auth.cache", "Roles a session has cached"]);
    expect(subjectsOf(world)).toContainEqual(["auth.roles", "Who may do what"]);
    expect(subjectDetailOf(world, "auth.cache")?.gloss).toBe("Roles a session has cached");
  });
});
