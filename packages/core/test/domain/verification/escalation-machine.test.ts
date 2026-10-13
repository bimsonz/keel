import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  type Committed,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import {
  decideEscalation,
  Escalation,
  type EscalationCommand,
  EscalationEvent,
  type EscalationOption,
  evolveEscalation,
  replayEscalation,
  RulingOptionUnknown,
} from "../../../src/domain/verification/index.ts";
import { escalationChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
import {
  eventsOf,
  failureTag,
  type Fold,
  type Machine,
  memo,
  play,
  tour,
} from "../../support/machine.ts";

/** Each property plays hundreds of seeded runs; on a busy runner one can pass vitest's 5 s default. */
const PROPERTY_TIMEOUT = 60_000;

const T0 = Instant(1_760_000_000_000);
const ESCALATION = makeId("esc", "0".repeat(26));
const CHANGE = makeId("chg", "0".repeat(26));
const DECISION = makeId("dec", "0".repeat(26));
const UNKNOWN = "not-an-option";

type Kind = EscalationCommand["_tag"];
type Key = "none" | Escalation["state"];
const KINDS: readonly Kind[] = ["Raise", "Rule", "Withdraw"];
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Raise"],
  open: ["Rule", "Rule", "Withdraw"],
  ruled: KINDS,
  withdrawn: KINDS,
};

interface Step {
  readonly mode: "progress" | "any";
  readonly pick: number;
  /** Which raise to try (three valid, then each way to be invalid), and whether a ruling names a stranger. */
  readonly variant: number;
}
const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 5, arbitrary: fc.constant("progress" as const) },
    { weight: 2, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
  variant: fc.nat({ max: 5 }),
});
const planArb = fc.array(stepArb, { minLength: 2, maxLength: 12 });

const option = (id: string): EscalationOption => ({
  id,
  label: `choose ${id}`,
  consequence: `what ${id} does`,
});
const OPTIONS = [option("keep"), option("revert"), option("overrule")];

/** Valid raises with two or three options, then one option, a repeated id, and a default that is no option. */
const raise = (variant: number): EscalationCommand => {
  const base = {
    _tag: "Raise",
    question: "Should revocation be checked per request?",
    about: { kind: "change", id: CHANGE },
    category: "permission-semantics",
    evidence: [{ class: "proof", summary: "probe fails in AB", ref: "prb_1" }],
    precedents: [DECISION],
  } as const;
  switch (variant) {
    case 0:
      return { ...base, options: OPTIONS.slice(0, 2), default: "keep" };
    case 1:
      return { ...base, options: OPTIONS, default: "revert" };
    case 2:
      return { ...base, options: OPTIONS, default: "overrule" };
    case 3:
      return { ...base, options: OPTIONS.slice(0, 1), default: "keep" };
    case 4:
      return { ...base, options: [option("keep"), option("keep")], default: "keep" };
    default:
      return { ...base, options: OPTIONS.slice(0, 2), default: UNKNOWN };
  }
};

const build = (kind: Kind, state: Escalation | undefined, step: Step): EscalationCommand => {
  switch (kind) {
    case "Raise":
      return raise(step.variant);
    case "Rule": {
      const ids = state?.options.map((o) => o.id) ?? ["keep"];
      const chosen = step.variant % 3 === 2 ? UNKNOWN : (ids[step.pick % ids.length] ?? "keep");
      return {
        _tag: "Rule",
        option: chosen,
        by: "operator:zb",
        ...(step.pick % 2 === 0 ? { rationale: "the tenet still holds" } : {}),
      };
    }
    case "Withdraw":
      return { _tag: "Withdraw", reason: "the conflict was dismissed" };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

const machine: Machine<
  Escalation,
  EscalationCommand,
  EscalationEvent,
  { readonly now: Instant; readonly escalationId: typeof ESCALATION }
> = { decide: decideEscalation, evolve: evolveEscalation };

const run = memo((steps: readonly Step[]) =>
  play(
    machine,
    {
      start: T0,
      dt: () => 1,
      facts: (now) => ({ now, escalationId: ESCALATION }),
      every: (state, step) => KINDS.map((k) => build(k, state, step)),
      choose: (state, step) => {
        const choices = step.mode === "progress" ? PROGRESS[state?.state ?? "none"] : KINDS;
        return build(choices[step.pick % choices.length] ?? "Raise", state, step);
      },
    },
    steps,
  ),
);

/** A raise stands with at least two options, unique ids, and a default among them. */
const raisable = (c: Extract<EscalationCommand, { _tag: "Raise" }>): boolean => {
  const ids = c.options.map((o) => o.id);
  return ids.length >= 2 && new Set(ids).size === ids.length && ids.includes(c.default);
};

/** The docs' table (state-machines.md § Escalation), typed independently of `decideEscalation`. */
const oracle = (before: Escalation | undefined, command: EscalationCommand): Key | "refused" => {
  if (before === undefined)
    return command._tag === "Raise" && raisable(command) ? "open" : "refused";
  switch (command._tag) {
    case "Raise":
      return "refused";
    case "Rule":
      return before.state === "open" && before.options.some((o) => o.id === command.option)
        ? "ruled"
        : "refused";
    case "Withdraw":
      return before.state === "open" ? "withdrawn" : "refused";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const comparable = (e: Escalation | undefined): string =>
  e === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Escalation)(e)));
const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));
const throughTheWire = (log: readonly Committed<EscalationEvent>[]): Committed<EscalationEvent>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(EscalationEvent)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(EscalationEvent)(w.payload),
  }));

const drive = (commands: readonly EscalationCommand[]) => {
  let state: Escalation | undefined;
  const results: ReturnType<typeof decideEscalation>[] = [];
  for (const command of commands) {
    const result = decideEscalation(state, command, { now: T0, escalationId: ESCALATION });
    results.push(result);
    if (Result.isSuccess(result))
      for (const payload of result.success) state = evolveEscalation(state, { at: T0, payload });
  }
  return { state, results };
};
const rule = (chosen: string): EscalationCommand => ({
  _tag: "Rule",
  option: chosen,
  by: "operator:zb",
});
const terminal = (e: Escalation | undefined): boolean =>
  e?.state === "ruled" || e?.state === "withdrawn";

describe("the Escalation machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[escalation.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const expected = oracle(r.before, p.command);
            return expected === "refused"
              ? Result.isFailure(p.result)
              : Result.isSuccess(p.result) && !p.threw && (p.after?.state ?? "none") === expected;
          }),
        ),
      ),
    );
    // Mission Control's inbox: raised with three options, ruled by id.
    const ruled = drive([raise(1), rule("keep")]);
    expect(ruled.state).toMatchObject({ state: "ruled", ruling: { option: "keep" } });
  });

  it("[escalation.one-terminal] a ruled or withdrawn escalation takes no command", () => {
    let ended = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          if (!terminal(r.before)) return true;
          ended++;
          return r.probes.every((p) => Result.isFailure(p.result));
        }),
      ),
    );
    expect(ended).toBeGreaterThan(0);
    const withdrawn = drive([
      raise(0),
      build("Withdraw", undefined, { mode: "any", pick: 0, variant: 0 }),
      raise(0),
    ]);
    expect(failureTag(withdrawn.results[2] ?? Result.succeed([]))).toBe("EscalationStateRefused");
  });

  it("[escalation.replay] at every step, the events so far, through the wire, replay to the same escalation", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) => comparable(replayEscalation(throughTheWire(r.log))) === comparable(r.after),
        ),
      ),
    );
    expect(drive([raise(2)]).state).toMatchObject({
      state: "open",
      default: "overrule",
      category: "permission-semantics",
      evidence: [{ class: "proof" }],
    });
  });

  it("[escalation.decide-evolvable] evolve takes every event decide emits, for every command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    expect(() =>
      evolveEscalation(undefined, {
        at: T0,
        payload: { _tag: "RulingGiven", escalationId: ESCALATION, option: "keep", by: "op" },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[escalation.option-ids] a ruling naming an unknown option is refused, and its next actions rule exactly the valid ids", () => {
    let unknown = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const before = r.before;
            const c = p.command;
            if (c._tag !== "Rule" || before?.state !== "open") return true;
            if (before.options.some((o) => o.id === c.option)) return Result.isSuccess(p.result);
            unknown++;
            const failure = Result.isFailure(p.result) ? p.result.failure : undefined;
            if (!(failure instanceof RulingOptionUnknown)) return false;
            const offered = failure.nextActions.map((a) => a.args?.["option"]);
            return offered.join() === before.options.map((o) => o.id).join();
          }),
        ),
      ),
    );
    expect(unknown).toBeGreaterThan(0);
    const stranger = drive([raise(0), rule(UNKNOWN)]);
    expect(failureTag(stranger.results[1] ?? Result.succeed([]))).toBe("RulingOptionUnknown");
    expect(stranger.state?.state).toBe("open");
  });

  it("[escalation.ruled-once] once ruled or withdrawn, a ruling or a withdrawal is refused and changes nothing", () => {
    let repeats = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            if (!terminal(r.before) || p.command._tag === "Raise") return true;
            repeats++;
            return (
              failureTag(p.result) === "EscalationStateRefused" &&
              comparable(p.after) === comparable(r.before)
            );
          }),
        ),
      ),
    );
    expect(repeats).toBeGreaterThan(0);
    // R3: even the identical ruling again is refused; the doorway's idempotency key covers retries.
    const twice = drive([raise(0), rule("keep"), rule("keep")]);
    expect(failureTag(twice.results[2] ?? Result.succeed([]))).toBe("EscalationStateRefused");
  });

  it("[escalation.raise-valid] an escalation is raised only with at least two options, unique ids, and a default among them", () => {
    let refused = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const c = p.command;
            if (c._tag !== "Raise" || r.before !== undefined) return true;
            if (raisable(c)) return Result.isSuccess(p.result);
            refused++;
            return failureTag(p.result) === "InvalidEscalation";
          }),
        ),
      ),
    );
    expect(refused).toBeGreaterThan(0);
    expect(
      [3, 4, 5].map((v) => failureTag(drive([raise(v)]).results[0] ?? Result.succeed([]))),
    ).toEqual(["InvalidEscalation", "InvalidEscalation", "InvalidEscalation"]);
  });
});

// The chart checks the machine; it never drives it.

const escalationView: View<Escalation, EscalationEvent> = {
  from: (f) => f.before?.state ?? "none",
  to: (f) => f.after.state,
};

let walkedTour: readonly Fold<Escalation, EscalationEvent>[] | undefined;
const escalationTour = (): readonly Fold<Escalation, EscalationEvent>[] => {
  walkedTour ??= tour(machine, {
    start: T0,
    facts: (now) => ({ now, escalationId: ESCALATION }),
    moves: (state) =>
      KINDS.flatMap((kind) =>
        [0, 1, 2, 3, 4, 5].map((variant) => ({
          command: build(kind, state, { mode: "any", pick: 0, variant }),
          dt: 1,
        })),
      ),
    signature: (e) => e?.state ?? "none",
  });
  return walkedTour;
};

const ANOTHER = makeId("esc", `${"0".repeat(25)}1`);

/** What the fold's table is about: whose the escalation is, its state, the options it offers and how it ended. */
interface Folded {
  readonly id: Escalation["id"];
  readonly state: Escalation["state"];
  readonly options: readonly string[];
  readonly ended?: string;
}

/** The fold's from-table (state-machines.md § Escalation), typed apart from `evolveEscalation`. */
const folds = (from: Folded | undefined, event: EscalationEvent): Folded | "illegal" => {
  if (from === undefined)
    return event._tag === "EscalationRaised"
      ? { id: event.escalationId, state: "open", options: event.options.map((o) => o.id) }
      : "illegal";
  if (event.escalationId !== from.id || from.state !== "open") return "illegal";
  switch (event._tag) {
    case "EscalationRaised":
      return "illegal";
    case "RulingGiven":
      return from.options.includes(event.option)
        ? { ...from, state: "ruled", ended: event.option }
        : "illegal";
    case "EscalationWithdrawn":
      return { ...from, state: "withdrawn", ended: event.reason };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

describe("the Escalation fold", () => {
  it("[escalation.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Escalation, EscalationEvent, Folded>({
      evolve: evolveEscalation,
      walked: escalationTour(),
      summary: (e) => ({
        id: e.id,
        state: e.state,
        options: e.options.map((o) => o.id),
        ...(e.ruling === undefined ? {} : { ended: e.ruling.option }),
        ...(e.withdrawnReason === undefined ? {} : { ended: e.withdrawnReason }),
      }),
      shown: (f) =>
        `${f.id} ${f.state} of ${f.options.join("/")}${f.ended === undefined ? "" : `, ${f.ended}`}`,
      // Each event as committed and as another escalation's, and a ruling for an option never offered.
      forms: (event) => [
        event,
        { ...event, escalationId: ANOTHER },
        ...(event._tag === "RulingGiven" ? [{ ...event, option: UNKNOWN }] : []),
      ],
      times: [T0],
      table: folds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Five rows by eleven forms: four raises, a ruling and a withdrawal, each as this
    // escalation's and as another's, and the ruling for an option never offered.
    expect(foldShape(cases)).toEqual({
      folds: 55,
      refused: 45,
      rows: [
        "none",
        `${ESCALATION} open of keep/revert`,
        `${ESCALATION} open of keep/revert/overrule`,
        `${ESCALATION} ruled of keep/revert, keep`,
        `${ESCALATION} withdrawn of keep/revert, the conflict was dismissed`,
      ],
    });
  });
});

describe("the Escalation chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[escalation.chart] every state change a run makes is an edge of the Escalation chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) =>
            offChart(
              escalationChart,
              foldsOf(machine, r.before, [r.taken.result, ...r.probes.map((p) => p.result)], r.now),
              escalationView,
            ).length === 0,
        ),
      ),
    );
    const walked = escalationTour();
    expect(offChart(escalationChart, walked, escalationView)).toEqual([]);
    expect(uncovered(escalationChart, walked, escalationView)).toEqual([]);
  });
});

// One explicit pin: the default is a suggestion, never applied by the machine.
describe("the Escalation's default", () => {
  it("is offered, not applied: an open escalation stays open however long it waits", () => {
    const open = drive([raise(1)]);
    expect(open.state).toMatchObject({ state: "open", default: "revert" });
    expect(open.state?.ruling).toBeUndefined();
    expect(eventsOf(open.results[0] ?? Result.succeed([])).map((e) => e._tag)).toEqual([
      "EscalationRaised",
    ]);
  });
});
