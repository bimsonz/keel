import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readScope, scopeCovers } from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  type Committed,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import {
  Decision,
  type DecisionCommand,
  DecisionEvent,
  decideDecision,
  evolveDecision,
  replayDecision,
  type RulingFacts,
} from "../../../src/domain/memory/index.ts";
import { decisionChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
import { failureTag, type Fold, type Machine, memo, play, tour } from "../../support/machine.ts";

/** Each property plays hundreds of seeded runs; on a busy runner one can pass vitest's 5 s default. */
const PROPERTY_TIMEOUT = 60_000;

const T0 = Instant(1_760_000_000_000);
const DECISION = makeId("dec", "0".repeat(26));
const LATER = makeId("dec", `${"0".repeat(25)}1`);
const ESCALATION = makeId("esc", "0".repeat(26));
const CHANGE = makeId("chg", "0".repeat(26));
const SCOPES = [undefined, "env:prod", "env:prod;tenant:t1", "tenant:t1"] as const;

type Kind = DecisionCommand["_tag"];
type Key = "none" | Decision["state"];
const KINDS: readonly Kind[] = ["Record", "Supersede", "Overrule"];
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Record"],
  active: ["Supersede", "Overrule"],
  superseded: KINDS,
  overruled: KINDS,
};

interface Step {
  readonly mode: "progress" | "any";
  readonly pick: number;
  /** Which escalation the owning DO looked up for this step. */
  readonly ruling: number;
  readonly scope: number;
}
const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 5, arbitrary: fc.constant("progress" as const) },
    { weight: 2, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
  ruling: fc.nat({ max: 5 }),
  scope: fc.nat({ max: SCOPES.length - 1 }),
});
const planArb = fc.array(stepArb, { minLength: 2, maxLength: 12 });

const OPTIONS = ["keep", "revert", "overrule"].map((id) => ({
  id,
  label: `choose ${id}`,
  consequence: `what ${id} does`,
}));
const escalation = (
  state: RulingFacts["state"],
  chosen: string | undefined,
  category = "permission-semantics",
): RulingFacts => ({
  id: ESCALATION,
  state,
  category,
  options: OPTIONS,
  evidence: [{ class: "proof", summary: "probe fails in AB" }],
  ...(chosen === undefined ? {} : { ruling: { option: chosen } }),
});
/** Ruled keep; ruled overrule on an overrule request; open; none; overrule on another category; withdrawn. */
const RULINGS: readonly (RulingFacts | undefined)[] = [
  escalation("ruled", "keep"),
  escalation("ruled", "overrule", "overrule-request"),
  escalation("open", undefined),
  undefined,
  escalation("ruled", "overrule"),
  escalation("withdrawn", undefined),
];
const rulingOf = (step: Step): RulingFacts | undefined => RULINGS[step.ruling % RULINGS.length];

const build = (kind: Kind, step: Step): DecisionCommand => {
  const scope = SCOPES[step.scope % SCOPES.length];
  switch (kind) {
    case "Record":
      return { _tag: "Record", ...(scope === undefined ? {} : { scope }) };
    case "Supersede": {
      const wider = SCOPES[(step.scope + step.pick) % SCOPES.length];
      return { _tag: "Supersede", by: LATER, ...(wider === undefined ? {} : { scope: wider }) };
    }
    case "Overrule":
      return { _tag: "Overrule", by: LATER, requestedBy: CHANGE };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

type Facts = {
  readonly now: Instant;
  readonly decisionId: typeof DECISION;
  readonly escalation?: RulingFacts;
};
const machine: Machine<Decision, DecisionCommand, DecisionEvent, Facts> = {
  decide: decideDecision,
  evolve: evolveDecision,
};
const factsAt = (now: Instant, ruling: RulingFacts | undefined): Facts => ({
  now,
  decisionId: DECISION,
  ...(ruling === undefined ? {} : { escalation: ruling }),
});

const run = memo((steps: readonly Step[]) =>
  play(
    machine,
    {
      start: T0,
      dt: () => 1,
      facts: (now, step: Step) => factsAt(now, rulingOf(step)),
      every: (_state, step) => KINDS.map((k) => build(k, step)),
      choose: (state, step) => {
        const choices = step.mode === "progress" ? PROGRESS[state?.state ?? "none"] : KINDS;
        return build(choices[step.pick % choices.length] ?? "Record", step);
      },
    },
    steps,
  ),
);

/** Same or wider, in the proposition scope grammar; an absent scope is everywhere (R4). */
const sameOrWider = (outer: string | undefined, inner: string | undefined): boolean => {
  const o = readScope(outer);
  const i = readScope(inner);
  return Result.isSuccess(o) && Result.isSuccess(i) && scopeCovers(o.success, i.success);
};

/** The docs' table (state-machines.md § Decision), typed independently of `decideDecision`. */
const oracle = (
  before: Decision | undefined,
  command: DecisionCommand,
  ruling: RulingFacts | undefined,
): Key | "refused" => {
  if (before === undefined)
    return command._tag === "Record" && ruling?.state === "ruled" && ruling.ruling !== undefined
      ? "active"
      : "refused";
  if (before.state !== "active") return "refused";
  switch (command._tag) {
    case "Record":
      return "refused";
    case "Supersede":
      return sameOrWider(command.scope, before.scope) ? "superseded" : "refused";
    case "Overrule":
      return ruling?.state === "ruled" &&
        ruling.category === "overrule-request" &&
        ruling.ruling?.option === "overrule"
        ? "overruled"
        : "refused";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const comparable = (d: Decision | undefined): string =>
  d === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Decision)(d)));
const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));
const throughTheWire = (log: readonly Committed<DecisionEvent>[]): Committed<DecisionEvent>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(DecisionEvent)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(DecisionEvent)(w.payload),
  }));

const drive = (steps: readonly (readonly [DecisionCommand, RulingFacts | undefined])[]) => {
  let state: Decision | undefined;
  const results: ReturnType<typeof decideDecision>[] = [];
  for (const [command, ruling] of steps) {
    const result = decideDecision(state, command, factsAt(T0, ruling));
    results.push(result);
    if (Result.isSuccess(result))
      for (const payload of result.success) state = evolveDecision(state, { at: T0, payload });
  }
  return { state, results };
};
const record = (scope?: string): DecisionCommand => ({
  _tag: "Record",
  ...(scope === undefined ? {} : { scope }),
});
const supersede = (scope?: string): DecisionCommand => ({
  _tag: "Supersede",
  by: LATER,
  ...(scope === undefined ? {} : { scope }),
});

describe("the Decision machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[decision.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) =>
          r.probes.every((p) => {
            const step = steps[i];
            const expected = oracle(r.before, p.command, step && rulingOf(step));
            return expected === "refused"
              ? Result.isFailure(p.result)
              : Result.isSuccess(p.result) && !p.threw && (p.after?.state ?? "none") === expected;
          }),
        ),
      ),
    );
    const overruled = drive([
      [record(), RULINGS[0]],
      [{ _tag: "Overrule", by: LATER, requestedBy: CHANGE }, RULINGS[1]],
    ]);
    expect(overruled.state).toMatchObject({ state: "overruled", endedBy: LATER });
  });

  it("[decision.one-terminal] a superseded or overruled decision takes no command", () => {
    let ended = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          if (r.before === undefined || r.before.state === "active") return true;
          ended++;
          return r.probes.every((p) => Result.isFailure(p.result));
        }),
      ),
    );
    expect(ended).toBeGreaterThan(0);
    const done = drive([
      [record("env:prod"), RULINGS[0]],
      [supersede(), undefined],
      [supersede(), undefined],
    ]);
    expect(failureTag(done.results[2] ?? Result.succeed([]))).toBe("DecisionStateRefused");
  });

  it("[decision.replay] at every step, the events so far, through the wire, replay to the same decision", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) => comparable(replayDecision(throughTheWire(r.log))) === comparable(r.after),
        ),
      ),
    );
    expect(drive([[record("env:prod"), RULINGS[0]]]).state).toMatchObject({
      state: "active",
      option: "keep",
      summary: "choose keep",
      scope: "env:prod",
      evidence: ["proof: probe fails in AB"],
    });
  });

  it("[decision.decide-evolvable] evolve takes every event decide emits, for every command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    expect(() =>
      evolveDecision(undefined, {
        at: T0,
        payload: { _tag: "DecisionSuperseded", decisionId: DECISION, by: LATER },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[decision.recorded-from-ruling] a decision is recorded only from a ruled escalation, and rejects exactly the options not chosen", () => {
    let recorded = 0;
    let unruled = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) =>
          r.probes.every((p) => {
            if (p.command._tag !== "Record" || r.before !== undefined) return true;
            const ruling = steps[i] && rulingOf(steps[i]);
            const chosen = ruling?.state === "ruled" ? ruling.ruling?.option : undefined;
            if (chosen === undefined) {
              unruled++;
              return failureTag(p.result) === "DecisionStateRefused";
            }
            recorded++;
            const e = Result.isSuccess(p.result) ? p.result.success[0] : undefined;
            return (
              e?._tag === "DecisionRecorded" &&
              e.option === chosen &&
              e.alternatives.map((a) => a.option).join() ===
                (ruling?.options ?? [])
                  .map((o) => o.id)
                  .filter((id) => id !== chosen)
                  .join()
            );
          }),
        ),
      ),
    );
    expect(recorded).toBeGreaterThan(0);
    expect(unruled).toBeGreaterThan(0);
    const kept = drive([[record(), RULINGS[0]]]);
    expect(kept.state?.alternatives).toEqual([
      { option: "revert", reasonRejected: "what revert does" },
      { option: "overrule", reasonRejected: "what overrule does" },
    ]);
  });

  it("[decision.supersede-scope] a decision is superseded only by one over the same or a wider scope", () => {
    let narrower = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const c = p.command;
            if (c._tag !== "Supersede" || r.before?.state !== "active") return true;
            const allowed = sameOrWider(c.scope, r.before.scope);
            if (!allowed) narrower++;
            return allowed === Result.isSuccess(p.result);
          }),
        ),
      ),
    );
    expect(narrower).toBeGreaterThan(0);
    // A prod-only decision is replaced by an everywhere one, never by a single tenant's.
    expect(
      drive([
        [record("env:prod"), RULINGS[0]],
        [supersede(), undefined],
      ]).state?.state,
    ).toBe("superseded");
    const tenant = drive([
      [record("env:prod"), RULINGS[0]],
      [supersede("env:prod;tenant:t1"), undefined],
    ]);
    expect(failureTag(tenant.results[1] ?? Result.succeed([]))).toBe("DecisionStateRefused");
  });
});

// The chart checks the machine; it never drives it.

const decisionView: View<Decision, DecisionEvent> = {
  from: (f) => f.before?.state ?? "none",
  to: (f) => f.after.state,
};

/** Every command from every state, with an escalation that lets each one through. */
let walkedTour: readonly Fold<Decision, DecisionEvent>[] | undefined;
const decisionTour = (): readonly Fold<Decision, DecisionEvent>[] => {
  walkedTour ??= tour(machine, {
    start: T0,
    facts: (now) => factsAt(now, RULINGS[1]),
    moves: () =>
      KINDS.map((kind) => ({
        command: build(kind, { mode: "any", pick: 0, ruling: 1, scope: 0 }),
        dt: 1,
      })),
    signature: (d) => d?.state ?? "none",
  });
  return walkedTour;
};

/** What the fold's table is about: whose the decision is, its state, and what ended it. */
interface Folded {
  readonly id: Decision["id"];
  readonly state: Decision["state"];
  readonly endedBy?: Decision["endedBy"];
}

/** The fold's from-table (state-machines.md § Decision), typed apart from `evolveDecision`. */
const folds = (from: Folded | undefined, event: DecisionEvent): Folded | "illegal" => {
  if (from === undefined)
    return event._tag === "DecisionRecorded"
      ? { id: event.decisionId, state: "active" }
      : "illegal";
  if (event.decisionId !== from.id || event._tag === "DecisionRecorded") return "illegal";
  if (from.state !== "active") return "illegal";
  return {
    id: from.id,
    state: event._tag === "DecisionSuperseded" ? "superseded" : "overruled",
    endedBy: event.by,
  };
};

describe("the Decision fold", () => {
  it("[decision.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Decision, DecisionEvent, Folded>({
      evolve: evolveDecision,
      walked: decisionTour(),
      summary: (d) => ({
        id: d.id,
        state: d.state,
        ...(d.endedBy === undefined ? {} : { endedBy: d.endedBy }),
      }),
      shown: (f) => `${f.id} ${f.state}${f.endedBy === undefined ? "" : ` by ${f.endedBy}`}`,
      // Each event as committed, and as another decision's.
      forms: (event) => [event, { ...event, decisionId: LATER }],
      times: [T0],
      table: folds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Four rows by three events, each as this decision's and as another's.
    expect(foldShape(cases)).toEqual({
      folds: 24,
      refused: 20,
      rows: [
        "none",
        `${DECISION} active`,
        `${DECISION} superseded by ${LATER}`,
        `${DECISION} overruled by ${LATER}`,
      ],
    });
  });
});

describe("the Decision chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[decision.chart] every state change a run makes is an edge of the Decision chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) =>
            offChart(
              decisionChart,
              foldsOf(machine, r.before, [r.taken.result, ...r.probes.map((p) => p.result)], r.now),
              decisionView,
            ).length === 0,
        ),
      ),
    );
    const walked = decisionTour();
    expect(offChart(decisionChart, walked, decisionView)).toEqual([]);
    expect(uncovered(decisionChart, walked, decisionView)).toEqual([]);
  });
});
