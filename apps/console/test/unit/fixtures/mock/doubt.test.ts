import { describe, expect, it } from "vitest";
import type { Doubt } from "../../../../src/domain/state.ts";
import { changePageOf } from "../../../../src/engine/select.ts";
import type { Resources } from "../../../../src/engine/select.ts";
import { subjectDetailOf } from "../../../../src/engine/subject.ts";
import { World } from "../../../../src/engine/world.ts";
import { checkLog } from "../../../fixtures/mock/conformance.ts";
import { QUICK_TOTAL, generateS6 } from "../../../fixtures/mock/doubt.ts";
import type { ScriptedEvent } from "../../../fixtures/mock/scripted.ts";

const NOTHING_READ: Resources = {
  diffs: new Map(),
  probes: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
};

/** Scenario 6 as told, or as `rewrite` leaves it, folded into a world with nothing of the console's own beside it. */
function folded(rewrite: (events: ScriptedEvent[]) => ScriptedEvent[] = (events) => events): World {
  const world = new World();
  for (const event of rewrite(structuredClone(generateS6(42).events))) world.apply(event, 0);
  return world;
}

const idOf = (world: World, label: string): string =>
  [...world.changes.values()].find((change) => change.label === label)?.id ?? "";

const doubtsOn = (world: World, label: string): Doubt[] | undefined =>
  changePageOf(world, idOf(world, label), NOTHING_READ)?.doubts;

/** Each doubt as one line: who put it in doubt, and the code it changed or the effect it made. */
const said = (doubts: Doubt[] | undefined): string[] | undefined =>
  doubts?.map((doubt) =>
    "effect" in doubt.cause
      ? `${doubt.by.label} effect ${doubt.cause.effect.predicate} ${doubt.cause.effect.relation} ${String(doubt.cause.effect.value)} ${doubt.cause.effect.unit ?? ""}`
      : `${doubt.by.label} edit ${doubt.cause.edit.path} ${doubt.cause.edit.symbol ?? "-"}`,
  );

/** Appends `extra` after the event at `index`, with that event's time. */
const after =
  (index: (events: ScriptedEvent[]) => number, extra: (events: ScriptedEvent[]) => ScriptedEvent) =>
  (events: ScriptedEvent[]): ScriptedEvent[] => {
    const at = index(events);
    return [...events.slice(0, at + 1), extra(events), ...events.slice(at + 1)];
  };

const last = (events: ScriptedEvent[]): number => events.length - 1;

/** The envelope of an event Keel commits after the story's last. */
const envelopeAfter = (events: ScriptedEvent[]) => ({
  eventId: `evt_after_${events.length}`,
  seq: events.length + 1,
  at: events[last(events)]?.at ?? "",
});

const subjectIdOf = (events: ScriptedEvent[]): string => {
  const minted = events.find((event) => event.type === "SubjectMinted");
  return minted?.type === "SubjectMinted" ? minted.payload.subjectId : "";
};

const changeIdOf = (events: ScriptedEvent[], label: string): string => {
  const declared = events.find((event) => event.type === "IntentDeclared" && event.label === label);
  return declared?.type === "IntentDeclared" ? declared.payload.changeId : "";
};

/** Keel reaffirms `premise` of #1 after the story's last event. */
const reaffirm = (premise: typeof QUICK_TOTAL) =>
  after(last, (events): ScriptedEvent => ({
    ...envelopeAfter(events),
    type: "PremiseReaffirmed",
    entity: { kind: "subject", id: subjectIdOf(events) },
    payload: {
      _tag: "PremiseReaffirmed",
      subjectId: subjectIdOf(events),
      changeId: changeIdOf(events, "#1"),
      premise,
    },
  }));

describe("scenario 6: a premise put in doubt", () => {
  it("[doubt.conforms] conforms to the catalogue and the state machines, and is told the same way twice", () => {
    expect(checkLog(generateS6(42).events)).toEqual([]);
    expect(JSON.stringify(generateS6(42).events)).toBe(JSON.stringify(generateS6(42).events));
  });

  it("[doubt.page] lists on the holder's page each premise Keel put in doubt, by an edit and by an effect, in Keel's order", () => {
    const world = folded();
    const doubts = doubtsOn(world, "#1");
    expect(said(doubts)).toEqual([
      "#2 edit src/billing/total.ts totalOf",
      "#3 effect bound at-most 2000 ms",
    ]);
    expect(doubts?.map((doubt) => doubt.premise)).toEqual([QUICK_TOTAL, QUICK_TOTAL]);
    expect(doubts?.map((doubt) => doubt.by.id)).toEqual([idOf(world, "#2"), idOf(world, "#3")]);
    // The changes that put it in doubt are told nothing of it: the premise is #1's.
    expect(doubtsOn(world, "#2")).toEqual([]);
    expect(doubtsOn(world, "#3")).toEqual([]);
  });

  it("[doubt.edit-symbol] an edit names its symbol only where the anchor does", () => {
    const world = folded((events) =>
      events.map((event) =>
        event.type === "PremiseSuspected" && event.payload.cause.anchor !== undefined
          ? {
              ...event,
              payload: {
                ...event.payload,
                cause: {
                  changeId: event.payload.cause.changeId,
                  anchor: { path: "src/billing/total.ts", commit: "c71e0a4" },
                },
              },
            }
          : event,
      ),
    );
    expect(said(doubtsOn(world, "#1"))).toEqual([
      "#2 edit src/billing/total.ts -",
      "#3 effect bound at-most 2000 ms",
    ]);
  });

  it("[doubt.reaffirmed] a premise Keel reaffirms is in doubt no more, and only that premise", () => {
    expect(doubtsOn(folded(reaffirm(QUICK_TOTAL)), "#1")).toEqual([]);
    // Its gloss, strength and anchors are not the claim: the same claim without them is the same premise.
    const { gloss: _gloss, strength: _strength, anchors: _anchors, ...bare } = QUICK_TOTAL;
    expect(doubtsOn(folded(reaffirm(bare)), "#1")).toEqual([]);
    expect(said(doubtsOn(folded(reaffirm({ ...QUICK_TOTAL, value: 80 })), "#1"))).toHaveLength(2);
    expect(said(doubtsOn(folded(reaffirm({ ...QUICK_TOTAL, unit: "s" })), "#1"))).toHaveLength(2);
    expect(
      said(doubtsOn(folded(reaffirm({ ...QUICK_TOTAL, relation: "at-least" })), "#1")),
    ).toHaveLength(2);
    expect(
      said(doubtsOn(folded(reaffirm({ ...QUICK_TOTAL, scope: "per invoice" })), "#1")),
    ).toHaveLength(2);
  });

  it("[doubt.retracted] a premise the change no longer holds is not listed as in doubt", () => {
    const retract = after(last, (events): ScriptedEvent => ({
      ...envelopeAfter(events),
      type: "IntentRevised",
      entity: { kind: "change", id: changeIdOf(events, "#1") },
      payload: {
        _tag: "IntentRevised",
        changeId: changeIdOf(events, "#1"),
        revision: 2,
        premisesAdded: [],
        premisesRetracted: [QUICK_TOTAL],
      },
    }));
    expect(doubtsOn(folded(retract), "#1")).toEqual([]);
  });

  it("[doubt.panel] the subject's list of changes says the same under the holder's row, for that subject alone", () => {
    const world = folded();
    const rows = subjectDetailOf(world, "billing.invoices")?.changes.listed;
    expect(Object.fromEntries((rows ?? []).map((row) => [row.label, said(row.doubts)]))).toEqual({
      "#1": ["#2 edit src/billing/total.ts totalOf", "#3 effect bound at-most 2000 ms"],
    });
    // A doubt Keel raised on another subject is that subject's to show.
    const elsewhere = folded((events) =>
      events.map((event) =>
        event.type === "PremiseSuspected" && event.payload.cause.effect !== undefined
          ? { ...event, payload: { ...event.payload, subjectId: "sub_elsewhere" } }
          : event,
      ),
    );
    const moved = subjectDetailOf(elsewhere, "billing.invoices")?.changes.listed.find(
      (row) => row.label === "#1",
    );
    expect(said(moved?.doubts)).toEqual(["#2 edit src/billing/total.ts totalOf"]);
    expect(said(doubtsOn(elsewhere, "#1"))).toHaveLength(2);
  });
});
