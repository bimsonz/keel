import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type PredicatePolicy,
  canonicalJson,
  type Committed,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import {
  type ContestingConflict,
  decideTenet,
  evolveTenet,
  replayTenet,
  Tenet,
  type TenetCommand,
  TenetEvent,
} from "../../../src/domain/memory/index.ts";
import { tenetChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
import { failureTag, type Fold, type Machine, memo, play, tour } from "../../support/machine.ts";

/** Each property plays hundreds of seeded runs; on a busy runner one can pass vitest's 5 s default. */
const PROPERTY_TIMEOUT = 60_000;

const T0 = Instant(1_760_000_000_000);
const TENET = makeId("tnt", "0".repeat(26));
const NEXT = makeId("tnt", `${"0".repeat(25)}1`);
const SUBJECT = makeId("sub", "0".repeat(26));
const CHANGE = makeId("chg", "0".repeat(26));
const CHALLENGER = makeId("chg", `${"0".repeat(25)}1`);
const STRANGER = makeId("chg", `${"0".repeat(25)}2`);
const CONFLICT = makeId("cfl", "0".repeat(26));
const OTHER = makeId("cfl", `${"0".repeat(25)}1`);
const DECISION = makeId("dec", "0".repeat(26));
const GUARDS = [makeId("grd", "0".repeat(26)), makeId("grd", `${"0".repeat(25)}1`)];

type Kind = TenetCommand["_tag"];
type Key = "none" | Tenet["state"];
const KINDS: readonly Kind[] = ["Establish", "Contest", "Reaffirm", "Retract", "Supersede"];
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Establish"],
  // Weighted towards Contested, where retraction and its policy live.
  established: ["Contest", "Contest", "Contest", "Supersede"],
  contested: ["Reaffirm", "Retract"],
  retracted: KINDS,
  superseded: KINDS,
};

const conflict = (
  state: string,
  move?: string,
  parties: readonly string[] = [CHALLENGER, TENET],
  id = CONFLICT,
): ContestingConflict => ({ id, state, parties, ...(move === undefined ? {} : { move }) });
const PROVEN = conflict("proven");
/** What the owning DO looked up: open, settled either way, against someone else, another conflict, or nothing. */
const CONFLICTS: readonly (ContestingConflict | undefined)[] = [
  conflict("suspected"),
  PROVEN,
  conflict("probing"),
  conflict("dismissed"),
  conflict("resolved", "distinguish"),
  conflict("resolved", "escalate"),
  conflict("resolved", "proceed"),
  conflict("escalated"),
  conflict("proven", undefined, [STRANGER, NEXT]),
  conflict("proven", undefined, [CHALLENGER, TENET], OTHER),
  undefined,
  // Weighted towards the proven conflict a retraction by proof needs.
  PROVEN,
  PROVEN,
  PROVEN,
];
const POLICIES: readonly (PredicatePolicy | undefined)[] = [
  undefined,
  "block",
  "advise",
  "annotate",
];

interface Step {
  readonly mode: "progress" | "any";
  readonly pick: number;
  readonly conflict: number;
  readonly policy: number;
  /** Whether a Retract carries a ruling. */
  readonly ruled: boolean;
  readonly change: number;
  readonly guards: number;
  /** Which conflict a Contest or Reaffirm names. */
  readonly target: number;
}
const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 5, arbitrary: fc.constant("progress" as const) },
    { weight: 2, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
  conflict: fc.nat({ max: CONFLICTS.length - 1 }),
  policy: fc.nat({ max: POLICIES.length - 1 }),
  ruled: fc.boolean(),
  change: fc.nat({ max: 2 }),
  guards: fc.nat({ max: 3 }),
  target: fc.nat({ max: 3 }),
});
const planArb = fc.array(stepArb, { minLength: 2, maxLength: 12 });

const conflictOf = (step: Step): ContestingConflict | undefined =>
  CONFLICTS[step.conflict % CONFLICTS.length];
const policyOf = (step: Step): PredicatePolicy | undefined =>
  POLICIES[step.policy % POLICIES.length];

const build = (kind: Kind, step: Step): TenetCommand => {
  const target = step.target === 3 ? OTHER : CONFLICT;
  switch (kind) {
    case "Establish":
      return {
        _tag: "Establish",
        subjectId: SUBJECT,
        predicate: "freshness",
        value: "per-request",
        changeId: CHANGE,
        guardIds: GUARDS.slice(0, step.guards % 3),
      };
    case "Contest":
      return { _tag: "Contest", conflictId: target };
    case "Reaffirm":
      return { _tag: "Reaffirm", conflictId: target };
    case "Retract":
      return {
        _tag: "Retract",
        changeId: step.change === 0 ? STRANGER : CHALLENGER,
        ...(step.ruled ? { decisionId: DECISION } : {}),
      };
    case "Supersede":
      return { _tag: "Supersede", by: step.pick % 5 === 0 ? TENET : NEXT };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

type Facts = {
  readonly now: Instant;
  readonly tenetId: typeof TENET;
  readonly conflict?: ContestingConflict;
  readonly policy?: PredicatePolicy;
};
const machine: Machine<Tenet, TenetCommand, TenetEvent, Facts> = {
  decide: decideTenet,
  evolve: evolveTenet,
};
const factsAt = (
  now: Instant,
  found: ContestingConflict | undefined,
  policy: PredicatePolicy | undefined,
): Facts => ({
  now,
  tenetId: TENET,
  ...(found === undefined ? {} : { conflict: found }),
  ...(policy === undefined ? {} : { policy }),
});

const run = memo((steps: readonly Step[]) =>
  play(
    machine,
    {
      start: T0,
      dt: () => 1,
      facts: (now, step: Step) => factsAt(now, conflictOf(step), policyOf(step)),
      every: (_state, step) => KINDS.map((k) => build(k, step)),
      choose: (state, step) => {
        const choices = step.mode === "progress" ? PROGRESS[state?.state ?? "none"] : KINDS;
        return build(choices[step.pick % choices.length] ?? "Establish", step);
      },
    },
    steps,
  ),
);

const OPEN = new Set(["suspected", "probing", "proven", "escalated"]);

/** The docs' table (state-machines.md § Tenet), typed independently of `decideTenet`. */
const oracle = (
  before: Tenet | undefined,
  command: TenetCommand,
  found: ContestingConflict | undefined,
  policy: PredicatePolicy | undefined,
): Key | "refused" => {
  if (before === undefined)
    return command._tag === "Establish" && command.guardIds.length > 0 ? "established" : "refused";
  switch (command._tag) {
    case "Establish":
      return "refused";
    case "Contest":
      return before.state === "established" &&
        found?.id === command.conflictId &&
        OPEN.has(found.state) &&
        found.parties.includes(before.id)
        ? "contested"
        : "refused";
    case "Reaffirm":
      return before.state === "contested" &&
        before.conflictId === command.conflictId &&
        found?.id === command.conflictId &&
        (found.state === "dismissed" ||
          (found.state === "resolved" && found.move === "distinguish"))
        ? "established"
        : "refused";
    case "Retract":
      if (before.state !== "contested") return "refused";
      if (command.decisionId !== undefined) return "retracted";
      return policy !== "block" &&
        found !== undefined &&
        found.id === before.conflictId &&
        found.state === "proven" &&
        found.parties.includes(command.changeId)
        ? "retracted"
        : "refused";
    case "Supersede":
      return before.state === "established" && command.by !== before.id ? "superseded" : "refused";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const comparable = (t: Tenet | undefined): string =>
  t === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Tenet)(t)));
const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));
const throughTheWire = (log: readonly Committed<TenetEvent>[]): Committed<TenetEvent>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(TenetEvent)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(TenetEvent)(w.payload),
  }));

/** The refusal's reason; the harness's probes type their rejection as just a tag. */
const reasonOf = (r: Result.Result<unknown, { readonly _tag: string }>): string | undefined => {
  if (Result.isSuccess(r)) return undefined;
  const reason: unknown = Reflect.get(r.failure, "reason");
  return typeof reason === "string" ? reason : undefined;
};
/** A decision as data: the events it commits, or the refusal and its reason. */
const said = (r: ReturnType<typeof decideTenet>): string =>
  Result.isSuccess(r)
    ? JSON.stringify(r.success)
    : `${r.failure._tag}:${r.failure.reason ?? ""}:${r.failure.state ?? ""}`;

type Driven = readonly (readonly [
  TenetCommand,
  ContestingConflict | undefined,
  PredicatePolicy | undefined,
])[];
const drive = (steps: Driven) => {
  let state: Tenet | undefined;
  const results: ReturnType<typeof decideTenet>[] = [];
  for (const [command, found, policy] of steps) {
    const result = decideTenet(state, command, factsAt(T0, found, policy));
    results.push(result);
    if (Result.isSuccess(result))
      for (const payload of result.success) state = evolveTenet(state, { at: T0, payload });
  }
  return { state, results };
};
const establish: Extract<TenetCommand, { _tag: "Establish" }> = {
  _tag: "Establish",
  subjectId: SUBJECT,
  predicate: "freshness",
  value: "per-request",
  changeId: CHANGE,
  guardIds: GUARDS.slice(0, 1),
};
const contest: TenetCommand = { _tag: "Contest", conflictId: CONFLICT };
const contested: Driven = [
  [establish, undefined, undefined],
  [contest, conflict("suspected"), undefined],
];
type Decided = ReturnType<typeof decideTenet>;
const last = (results: readonly Decided[]): Decided => results.at(-1) ?? Result.succeed([]);

describe("the Tenet machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[tenet.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) =>
          r.probes.every((p) => {
            const step = steps[i];
            const expected =
              step === undefined
                ? "refused"
                : oracle(r.before, p.command, conflictOf(step), policyOf(step));
            return expected === "refused"
              ? Result.isFailure(p.result)
              : Result.isSuccess(p.result) && !p.threw && (p.after?.state ?? "none") === expected;
          }),
        ),
      ),
    );
    const retracted = drive([
      ...contested,
      [{ _tag: "Retract", changeId: CHALLENGER }, PROVEN, "advise"],
    ]);
    expect(retracted.state).toMatchObject({
      state: "retracted",
      conflictId: CONFLICT,
      endedBy: CHALLENGER,
    });
    expect(retracted.state?.decisionId).toBeUndefined();
  });

  it("[tenet.one-terminal] a retracted or superseded tenet takes no command", () => {
    let ended = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          const s = r.before?.state;
          if (s !== "retracted" && s !== "superseded") return true;
          ended++;
          return r.probes.every((p) => Result.isFailure(p.result));
        }),
      ),
    );
    expect(ended).toBeGreaterThan(0);
    const done = drive([
      [establish, undefined, undefined],
      [{ _tag: "Supersede", by: NEXT }, undefined, undefined],
      [contest, conflict("suspected"), undefined],
    ]);
    expect(failureTag(last(done.results))).toBe("TenetStateRefused");
  });

  it("[tenet.replay] at every step, the events so far, through the wire, replay to the same tenet", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) => comparable(replayTenet(throughTheWire(r.log))) === comparable(r.after),
        ),
      ),
    );
    expect(
      drive([
        ...contested,
        [{ _tag: "Retract", changeId: CHALLENGER, decisionId: DECISION }, undefined, "block"],
      ]).state,
    ).toMatchObject({ state: "retracted", decisionId: DECISION, guards: [GUARDS[0]] });
  });

  it("[tenet.decide-evolvable] evolve takes every event decide emits, for every command tried in every state a run reaches", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    const established = drive([[establish, undefined, undefined]]).state;
    expect(() =>
      evolveTenet(established, {
        at: T0,
        payload: { _tag: "TenetReaffirmed", tenetId: TENET, conflictId: CONFLICT },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[tenet.guarded] a tenet is established only with at least one guard", () => {
    let unguarded = 0;
    let guarded = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "Establish" || r.before !== undefined) return true;
            if (p.command.guardIds.length === 0) {
              unguarded++;
              return reasonOf(p.result) === "unguarded";
            }
            guarded++;
            return Result.isSuccess(p.result);
          }),
        ),
      ),
    );
    expect(unguarded).toBeGreaterThan(0);
    expect(guarded).toBeGreaterThan(0);
    const bare = drive([[{ ...establish, guardIds: [] }, undefined, undefined]]);
    expect(reasonOf(last(bare.results))).toBe("unguarded");
  });

  it("[tenet.retract-needs-ruling] under block, a contested tenet is retracted only on a ruling", () => {
    let ruled = 0;
    let refused = 0;
    assertReaching(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) =>
          r.probes.every((p) => {
            const step = steps[i];
            if (p.command._tag !== "Retract" || r.before?.state !== "contested") return true;
            if (step === undefined || policyOf(step) !== "block") return true;
            if (p.command.decisionId !== undefined) {
              ruled++;
              return Result.isSuccess(p.result);
            }
            refused++;
            return reasonOf(p.result) === "ruling-required";
          }),
        ),
      ),
    );
    expect(ruled).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    // Proof the challenger landed on is not enough where the project blocks.
    const blocked = drive([
      ...contested,
      [{ _tag: "Retract", changeId: CHALLENGER }, PROVEN, "block"],
    ]);
    expect(reasonOf(last(blocked.results))).toBe("ruling-required");
  });

  it("[tenet.retract-by-proof] under advise or annotate, a contested tenet is retracted without a ruling only when its conflict is proven and the landing change is a party", () => {
    let retracted = 0;
    let unproven = 0;
    let stranger = 0;
    assertReaching(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) =>
          r.probes.every((p) => {
            const step = steps[i];
            const c = p.command;
            if (c._tag !== "Retract" || c.decisionId !== undefined) return true;
            if (r.before?.state !== "contested" || step === undefined) return true;
            if (policyOf(step) === "block") return true;
            const found = conflictOf(step);
            const contesting = found?.id === r.before.conflictId;
            const allowed =
              contesting && found?.state === "proven" && found.parties.includes(c.changeId);
            if (allowed) retracted++;
            else if (contesting && found?.state !== "proven") unproven++;
            else if (contesting) stranger++;
            const e = Result.isSuccess(p.result) ? p.result.success[0] : undefined;
            return allowed
              ? e?._tag === "TenetRetracted" &&
                  e.conflictId === r.before.conflictId &&
                  e.decisionId === undefined
              : reasonOf(p.result) === "not-proven";
          }),
        ),
      ),
    );
    expect(retracted).toBeGreaterThan(0);
    expect(unproven).toBeGreaterThan(0);
    expect(stranger).toBeGreaterThan(0);
    const suspected = drive([
      ...contested,
      [{ _tag: "Retract", changeId: CHALLENGER }, conflict("suspected"), "annotate"],
    ]);
    expect(reasonOf(last(suspected.results))).toBe("not-proven");
    const byStranger = drive([
      ...contested,
      [{ _tag: "Retract", changeId: STRANGER }, PROVEN, "advise"],
    ]);
    expect(reasonOf(last(byStranger.results))).toBe("not-proven");
  });

  it("[tenet.policy-default] with no policy, every command decides exactly as under advise", () => {
    let sensitive = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) => {
          const step = steps[i];
          if (step === undefined) return true;
          const found = conflictOf(step);
          return KINDS.map((k) => build(k, step)).every((command) => {
            const absent = decideTenet(r.before, command, factsAt(r.now, found, undefined));
            const advise = decideTenet(r.before, command, factsAt(r.now, found, "advise"));
            const block = decideTenet(r.before, command, factsAt(r.now, found, "block"));
            if (said(block) !== said(advise)) sensitive++;
            return said(absent) === said(advise);
          });
        }),
      ),
    );
    expect(sensitive).toBeGreaterThan(0);
    const unset = drive([
      ...contested,
      [{ _tag: "Retract", changeId: CHALLENGER }, PROVEN, undefined],
    ]);
    expect(unset.state?.state).toBe("retracted");
  });

  it("[tenet.reaffirm-on-settled] a contested tenet is reaffirmed only once its conflict is dismissed, or resolved by distinguish or yield", () => {
    let reaffirmed = 0;
    let open = 0;
    assertReaching(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) =>
          r.probes.every((p) => {
            const step = steps[i];
            const c = p.command;
            if (c._tag !== "Reaffirm" || r.before?.state !== "contested" || step === undefined)
              return true;
            const found = conflictOf(step);
            const ours = c.conflictId === r.before.conflictId && found?.id === c.conflictId;
            const settled =
              found?.state === "dismissed" ||
              (found?.state === "resolved" && found.move === "distinguish");
            if (ours && settled) reaffirmed++;
            if (ours && found !== undefined && OPEN.has(found.state)) open++;
            return ours && settled
              ? Result.isSuccess(p.result)
              : reasonOf(p.result) === "conflict-unsettled";
          }),
        ),
      ),
    );
    expect(reaffirmed).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(0);
    const proceeded = drive([
      ...contested,
      [{ _tag: "Reaffirm", conflictId: CONFLICT }, conflict("resolved", "proceed"), undefined],
    ]);
    expect(reasonOf(last(proceeded.results))).toBe("conflict-unsettled");
    const dismissed = drive([
      ...contested,
      [{ _tag: "Reaffirm", conflictId: CONFLICT }, conflict("dismissed"), undefined],
    ]);
    expect(dismissed.state?.state).toBe("established");
    expect(dismissed.state?.conflictId).toBeUndefined();
  });

  it("[tenet.contest-party] an established tenet is contested only by an open conflict that names it as a party", () => {
    let contestedBy = 0;
    let notParty = 0;
    assertReaching(
      fc.property(planArb, (steps) =>
        run(steps).every((r, i) =>
          r.probes.every((p) => {
            const step = steps[i];
            const c = p.command;
            if (c._tag !== "Contest" || r.before?.state !== "established" || step === undefined)
              return true;
            const found = conflictOf(step);
            const named = found !== undefined && found.id === c.conflictId && OPEN.has(found.state);
            const party = named && found.parties.includes(r.before.id);
            if (party) contestedBy++;
            else if (named) notParty++;
            return party
              ? Result.isSuccess(p.result)
              : reasonOf(p.result) === "conflict-not-against-tenet";
          }),
        ),
      ),
    );
    expect(contestedBy).toBeGreaterThan(0);
    expect(notParty).toBeGreaterThan(0);
    const elsewhere = drive([
      [establish, undefined, undefined],
      [contest, conflict("proven", undefined, [STRANGER, NEXT]), undefined],
    ]);
    expect(reasonOf(last(elsewhere.results))).toBe("conflict-not-against-tenet");
  });
});

// The chart checks the machine; it never drives it.

const tenetView: View<Tenet, TenetEvent> = {
  from: (f) => f.before?.state ?? "none",
  to: (f) => f.after.state,
};

/**
 * Every command from every state. A tour's facts depend only on the time, so
 * each move is tried after an odd and an even step: an open conflict at even
 * times lets Contest and a retraction by proof through, a dismissed one at
 * odd times lets Reaffirm through.
 */
let walkedTour: readonly Fold<Tenet, TenetEvent>[] | undefined;
const tenetTour = (): readonly Fold<Tenet, TenetEvent>[] => {
  walkedTour ??= tour(machine, {
    start: T0,
    facts: (now) => factsAt(now, now % 2 === 0 ? PROVEN : conflict("dismissed"), undefined),
    moves: () =>
      KINDS.flatMap((kind) =>
        [1, 2].map((dt) => ({
          command: build(kind, {
            mode: "any",
            pick: 1,
            conflict: 0,
            policy: 0,
            ruled: false,
            change: 1,
            guards: 1,
            target: 0,
          }),
          dt,
        })),
      ),
    signature: (t) => t?.state ?? "none",
  });
  return walkedTour;
};

/** What the fold's table is about: whose the tenet is, its state, the conflict contesting it and what ended it. */
interface Folded {
  readonly id: Tenet["id"];
  readonly state: Tenet["state"];
  readonly conflictId?: Tenet["conflictId"];
  readonly endedBy?: Tenet["endedBy"];
}

/** The fold's from-table (state-machines.md § Tenet), typed apart from `evolveTenet`. */
const folds = (from: Folded | undefined, event: TenetEvent): Folded | "illegal" => {
  if (from === undefined)
    return event._tag === "TenetEstablished" && event.guardIds.length > 0
      ? { id: event.tenetId, state: "established" }
      : "illegal";
  if (event.tenetId !== from.id) return "illegal";
  const contesting =
    from.state === "contested" && "conflictId" in event && event.conflictId === from.conflictId;
  switch (event._tag) {
    case "TenetEstablished":
      return "illegal";
    case "TenetContested":
      return from.state === "established"
        ? { id: from.id, state: "contested", conflictId: event.conflictId }
        : "illegal";
    case "TenetReaffirmed":
      return contesting ? { id: from.id, state: "established" } : "illegal";
    case "TenetRetracted":
      return contesting ? { ...from, state: "retracted", endedBy: event.changeId } : "illegal";
    case "TenetSuperseded":
      return from.state === "established"
        ? { id: from.id, state: "superseded", endedBy: event.by }
        : "illegal";
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

describe("the Tenet fold", () => {
  it("[tenet.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Tenet, TenetEvent, Folded>({
      evolve: evolveTenet,
      walked: tenetTour(),
      summary: (t) => ({
        id: t.id,
        state: t.state,
        ...(t.conflictId === undefined ? {} : { conflictId: t.conflictId }),
        ...(t.endedBy === undefined ? {} : { endedBy: t.endedBy }),
      }),
      shown: (f) =>
        [
          `${f.id} ${f.state}`,
          ...(f.conflictId === undefined ? [] : [`over ${f.conflictId}`]),
          ...(f.endedBy === undefined ? [] : [`by ${f.endedBy}`]),
        ].join(" "),
      // Each event as committed and as another tenet's; one that names a conflict, for
      // another conflict too; and a tenet established with no guard.
      forms: (event) => [
        event,
        { ...event, tenetId: NEXT },
        ...("conflictId" in event ? [{ ...event, conflictId: OTHER }] : []),
        ...(event._tag === "TenetEstablished" ? [{ ...event, guardIds: [] }] : []),
      ],
      times: [T0],
      table: folds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Five rows by fourteen forms: the five events, each also as another tenet's, the three
    // that name a conflict also for another one, and an establishing with no guard.
    expect(foldShape(cases)).toEqual({
      folds: 70,
      refused: 63,
      rows: [
        "none",
        `${TENET} established`,
        `${TENET} contested over ${CONFLICT}`,
        `${TENET} superseded by ${NEXT}`,
        `${TENET} retracted over ${CONFLICT} by ${CHALLENGER}`,
      ],
    });
  });
});

describe("the Tenet chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[tenet.chart] every state change a run makes is an edge of the Tenet chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) =>
            offChart(
              tenetChart,
              foldsOf(machine, r.before, [r.taken.result, ...r.probes.map((p) => p.result)], r.now),
              tenetView,
            ).length === 0,
        ),
      ),
    );
    const walked = tenetTour();
    expect(offChart(tenetChart, walked, tenetView)).toEqual([]);
    expect(uncovered(tenetChart, walked, tenetView)).toEqual([]);
  });
});
