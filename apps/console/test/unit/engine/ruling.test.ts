import { describe, expect, it } from "vitest";
import { rulingWords } from "../../../src/engine/ruling.ts";
import { World } from "../../../src/engine/world.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createRng } from "../../fixtures/prng.ts";

const RELIES = "chg_000000000000000000RELIES";
const CHANGES = "chg_00000000000000000CHANGES";
const CONFLICT = "cfl_00000000000000000000000001";
const QUESTION = "esc_00000000000000000000000001";
const SUBJECT = "swarm.r2610150314.allows";

/** keel/swarm's question: #10 relies on `allows` being pure, and #14 adds a log to it. Which holds? */
function effectPair(): World {
  const b = new ScriptBuilder("2026-10-15T03:00:00.000Z", createRng(11));
  for (const [changeId, label, goal] of [
    [RELIES, "#10", "Check permissions with allows"],
    [CHANGES, "#14", "Log every permission check"],
  ] as const)
    b.at(1).emit({
      type: "IntentDeclared",
      entity: { kind: "change", id: changeId },
      label,
      payload: {
        changeId,
        agentId: "agt_1",
        origin: "agent",
        revision: 1,
        goal,
        footprint: [],
        premises: [],
        leaseId: "l",
      },
    });
  b.at(2).emit({
    type: "ConflictSuspected",
    entity: { kind: "conflict", id: CONFLICT },
    label: "C-2",
    payload: {
      conflictId: CONFLICT,
      kind: "semantic",
      parties: [RELIES, CHANGES],
      subjectKey: SUBJECT,
      predicate: "purity",
      premise: {
        holder: RELIES,
        proposition: { subject: SUBJECT, predicate: "purity", relation: "is", value: true },
      },
      effect: {
        changeId: CHANGES,
        proposition: {
          subject: SUBJECT,
          predicate: "purity",
          relation: "is",
          value: false,
          gloss: "allows calls console.info",
        },
      },
    },
  });
  b.at(3).emit({
    type: "EscalationRaised",
    entity: { kind: "escalation", id: QUESTION },
    label: "E-2",
    payload: {
      escalationId: QUESTION,
      question: `${RELIES} relies on "${SUBJECT} purity is true", and ${CHANGES} makes it false. Which holds?`,
      options: [
        { id: "premise-holds", label: "The premise holds", consequence: `${CHANGES} must change.` },
        { id: "effect-stands", label: "The effect stands", consequence: `${RELIES} must change.` },
      ],
      about: { kind: "conflict", id: CONFLICT },
      category: "permission-semantics",
      evidence: [],
      precedents: [],
      default: "premise-holds",
    },
  });
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

describe("a question in words", () => {
  it("[ruling.words] names the two changes by number and says what each answer does to which", () => {
    const world = effectPair();
    const entry = world.escalations.get(QUESTION);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const words = rulingWords(world, entry);
    expect(words.title).toBe("Can allows stay pure?");
    expect(words.relies).toMatchObject({ label: "#10", on: "allows having no side effects" });
    expect(words.changes).toMatchObject({ label: "#14", does: "allows calls console.info" });
    expect(words.options.map((option) => [option.id, option.label])).toEqual([
      ["premise-holds", "Keep allows pure · #14 reworks"],
      ["effect-stands", "Accept #14 · #10 adapts"],
    ]);
  });
});
