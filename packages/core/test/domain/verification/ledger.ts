/**
 * A conflict and its probe as their owning DO runs them: one state holding
 * both, each command routed to its machine with the other entity as a fact,
 * and each event folded into every entity that takes it (the conflict folds
 * `ProbeDrafted` and `ProbeRan`). Both machines' properties play these runs.
 */
import { Result, Schema } from "effect";
import { type Proposition, SubjectKey, compare } from "../../../src/domain/coordination/index.ts";
import {
  canonicalJson,
  type Committed,
  ContentHash,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import {
  ADMISSION_RUNS,
  admit,
  Conflict,
  type ConflictCommand,
  ConflictEvent,
  type ConflictKind,
  type ConflictOrigin,
  type ConflictState,
  decideConflict,
  decideProbe,
  evolveConflict,
  evolveProbe,
  MAX_DRAFT_ATTEMPTS,
  Probe,
  type ProbeCommand,
  ProbeEvent,
  type ProbeOutcome,
  type ProbeState,
  type ProofWithoutProbe,
  type World,
} from "../../../src/domain/verification/index.ts";
import { fc } from "../../support/fast-check.ts";
import { type Fold, type Machine, memo, play, type Played, tour } from "../../support/machine.ts";

export const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
export const CONFLICT = makeId("cfl", ulid(1));
export const PROBE = makeId("prb", ulid(1));
export const GUARD = makeId("grd", ulid(1));
export const ESCALATION = makeId("esc", ulid(1));
export const DECISION = makeId("dec", ulid(1));
export const BATCH = makeId("bat", ulid(1));
export const CHANGE_A = makeId("chg", ulid(1));
export const CHANGE_B = makeId("chg", ulid(2));
export const TENET = makeId("tnt", ulid(1));
export const SUBJECT = makeId("sub", ulid(1));
export const BUNDLE = ContentHash.make(`sha256:${"0".repeat(64)}`);

export interface Ledger {
  readonly conflict?: Conflict;
  readonly probe?: Probe;
}
export type LedgerCommand =
  | { readonly _tag: "Conflict"; readonly command: ConflictCommand }
  | { readonly _tag: "Probe"; readonly command: ProbeCommand };
export type LedgerEvent = ConflictEvent | ProbeEvent;
export interface LedgerFacts {
  readonly now: Instant;
}

const CONFLICT_FOLDS: ReadonlySet<string> = new Set([
  "ConflictSuspected",
  "ProbeDrafted",
  "ProbeRan",
  "WorldCheckRan",
  "ConflictProven",
  "ConflictDismissed",
  "ConflictEscalated",
  "ConflictResolved",
]);
const PROBE_FOLDS: ReadonlySet<string> = new Set([
  "ProbeDrafted",
  "ProbeRan",
  "ProbeDiscarded",
  "GuardAdmitted",
  "GuardRetired",
]);
export const foldsIntoConflict = (e: LedgerEvent): e is ConflictEvent => CONFLICT_FOLDS.has(e._tag);
export const foldsIntoProbe = (e: LedgerEvent): e is ProbeEvent => PROBE_FOLDS.has(e._tag);

export const ledgerMachine: Machine<Ledger, LedgerCommand, LedgerEvent, LedgerFacts> = {
  decide: (state, command, { now }) =>
    command._tag === "Conflict"
      ? decideConflict(state?.conflict, command.command, {
          now,
          conflictId: CONFLICT,
          ...(state?.probe === undefined ? {} : { probe: state.probe }),
        })
      : decideProbe(state?.probe, command.command, {
          now,
          probeId: PROBE,
          ...(state?.conflict === undefined ? {} : { conflict: state.conflict }),
        }),
  evolve: (state, { at, payload }) => {
    const conflict = foldsIntoConflict(payload)
      ? evolveConflict(state?.conflict, { at, payload })
      : state?.conflict;
    const probe = foldsIntoProbe(payload)
      ? evolveProbe(state?.probe, { at, payload })
      : state?.probe;
    return {
      ...(conflict === undefined ? {} : { conflict }),
      ...(probe === undefined ? {} : { probe }),
    };
  },
};

// ------------------------------------------------------------------ plans

export const WORLDS: readonly World[] = ["trunk", "A", "B", "AB", "A-noop"];
type RunCells = Readonly<Record<World, ProbeOutcome>>;

const outcomeArb: fc.Arbitrary<ProbeOutcome> = fc.constantFrom("pass", "fail", "n/a");
/** A calibration run: mostly one that discriminates, sometimes noise. */
const runArb: fc.Arbitrary<RunCells> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      trunk: fc.constantFrom("pass" as const, "n/a" as const),
      A: fc.constant("pass" as const),
      B: outcomeArb,
      AB: fc.constant("fail" as const),
      "A-noop": fc.constant("fail" as const),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      trunk: outcomeArb,
      A: outcomeArb,
      B: outcomeArb,
      AB: outcomeArb,
      "A-noop": outcomeArb,
    }),
  },
);

/** The fault a plan's suspicion carries, if any: a conflict with no parties, a party twice, the wrong subject, no predicate. */
type Fault = "none" | "no-parties" | "party-twice" | "subject-flip" | "no-predicate";

export interface Step {
  readonly mode: "progress" | "any";
  readonly pick: number;
  readonly world: number;
  readonly run: number;
  readonly outcome: ProbeOutcome;
  /** Resolve with a decision; Prove with the kind's own proof. */
  readonly flag: boolean;
}

export interface Plan {
  readonly kind: ConflictKind;
  readonly origin: ConflictOrigin;
  readonly fault: Fault;
  /** Which of the premise at stake and the effect against it the suspicion names; a probe is drafted only with both. */
  readonly propositions: "both" | "premise" | "effect" | "none";
  readonly attempts: number;
  readonly matrix: readonly RunCells[];
  readonly steps: readonly Step[];
}

const weighted = (yes: number, no: number): fc.Arbitrary<boolean> =>
  fc.oneof(
    { weight: yes, arbitrary: fc.constant(true) },
    { weight: no, arbitrary: fc.constant(false) },
  );

const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 12, arbitrary: fc.constant("progress" as const) },
    { weight: 1, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
  world: fc.nat({ max: WORLDS.length - 1 }),
  // Now and then a run outside 1..3.
  run: fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 1, max: ADMISSION_RUNS }) },
    { weight: 1, arbitrary: fc.constantFrom(0, ADMISSION_RUNS + 1) },
  ),
  outcome: outcomeArb,
  flag: weighted(3, 1),
});

export const planArb: fc.Arbitrary<Plan> = fc.record({
  kind: fc.oneof(
    { weight: 4, arbitrary: fc.constant("semantic" as const) },
    {
      weight: 1,
      arbitrary: fc.constantFrom("textual" as const, "precedent" as const, "interaction" as const),
    },
  ),
  origin: fc.oneof(
    { weight: 4, arbitrary: fc.constant("fallout" as const) },
    { weight: 1, arbitrary: fc.constant("opinion" as const) },
  ),
  fault: fc.oneof(
    { weight: 12, arbitrary: fc.constant("none" as const) },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "no-parties" as const,
        "party-twice" as const,
        "subject-flip" as const,
        "no-predicate" as const,
      ),
    },
  ),
  propositions: fc.oneof(
    { weight: 9, arbitrary: fc.constant("both" as const) },
    {
      weight: 1,
      arbitrary: fc.constantFrom("premise" as const, "effect" as const, "none" as const),
    },
  ),
  attempts: fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 1, max: MAX_DRAFT_ATTEMPTS }) },
    { weight: 1, arbitrary: fc.constantFrom(0, MAX_DRAFT_ATTEMPTS + 1) },
  ),
  matrix: fc.array(runArb, { minLength: ADMISSION_RUNS, maxLength: ADMISSION_RUNS }),
  // Long enough to record a probe's 15 cells and still settle and resolve its conflict.
  steps: fc.array(stepArb, { minLength: 20, maxLength: 56 }),
});

// --------------------------------------------------------------- commands

const evaluation = SubjectKey.make("authz.permission-evaluation");
const freshness = (
  relation: Proposition["relation"],
  value: string,
  extra: Partial<Proposition> = {},
): Proposition => ({ subject: evaluation, predicate: "freshness", relation, value, ...extra });

/** The S-1 premise ("permission evaluation is at most per-request") against effects the lattice settles, and some it does not. */
export const PREMISE = freshness("at-most", "per-request");
export const EFFECTS: readonly Proposition[] = [
  freshness("is", "per-call"),
  freshness("is", "per-session"),
  freshness("at-most", "ttl:60"),
  freshness("is", "per-call", { scope: "env:prod" }),
  freshness("is", "static"),
  { ...freshness("is", "per-call"), subject: SubjectKey.make("billing.invoice") },
];

const proofFor = (kind: ConflictKind | undefined): ProofWithoutProbe =>
  kind === "precedent"
    ? { _tag: "guard", guardId: GUARD }
    : kind === "interaction"
      ? { _tag: "interaction", batchId: BATCH }
      : { _tag: "merge-refused", batchId: BATCH };
const PROOFS: readonly ProofWithoutProbe[] = [
  proofFor("textual"),
  proofFor("precedent"),
  proofFor("interaction"),
];

const suspect = (plan: Plan): ConflictCommand => {
  const subjectOwned = plan.kind === "semantic" || plan.kind === "precedent";
  const withSubject = plan.fault === "subject-flip" ? !subjectOwned : subjectOwned;
  const parties =
    plan.fault === "no-parties"
      ? []
      : plan.fault === "party-twice"
        ? [CHANGE_A, CHANGE_A]
        : [CHANGE_A, plan.kind === "precedent" ? TENET : CHANGE_B];
  return {
    _tag: "Suspect",
    kind: plan.kind,
    parties,
    ...(withSubject ? { subjectId: SUBJECT } : {}),
    ...(plan.kind === "semantic" && plan.fault !== "no-predicate"
      ? { predicate: "freshness" as const }
      : {}),
    ...(plan.origin === "fallout" ? {} : { origin: plan.origin }),
    ...(plan.propositions === "both" || plan.propositions === "premise"
      ? { premise: { holder: CHANGE_A, proposition: PREMISE } }
      : {}),
    ...(plan.propositions === "both" || plan.propositions === "effect"
      ? { effect: { changeId: CHANGE_B, proposition: EFFECTS[0] ?? PREMISE } }
      : {}),
  };
};

/** The first cell of the plan's matrix not yet recorded, run by run. */
const nextCell = (probe: Probe | undefined, plan: Plan) => {
  for (let run = 1; run <= ADMISSION_RUNS; run++)
    for (const world of WORLDS)
      if (!(probe?.cells ?? []).some((c) => c.run === run && c.world === world))
        return { world, run, outcome: plan.matrix[run - 1]?.[world] ?? "pass" };
  return { world: "A" as const, run: 1, outcome: "pass" as const };
};

export const KINDS = [
  "Suspect",
  "Prove",
  "Dismiss",
  "Settle",
  "Escalate",
  "Resolve",
  "RecordCheck",
  "Draft",
  "DraftFailed",
  "Record",
  "Retire",
] as const;
/** Every command tried in each state: the kinds a step draws, and a probe's run failing, which no step draws, so no plan's path moves. */
export const EVERY = [...KINDS, "RunFailed"] as const;
export type Kind = (typeof EVERY)[number];

const toConflict = (command: ConflictCommand): LedgerCommand => ({ _tag: "Conflict", command });
const toProbe = (command: ProbeCommand): LedgerCommand => ({ _tag: "Probe", command });

export const build = (
  kind: Kind,
  state: Ledger | undefined,
  plan: Plan,
  step: Step,
): LedgerCommand => {
  switch (kind) {
    case "Suspect":
      return toConflict(suspect(plan));
    case "Prove":
      return toConflict({
        _tag: "Prove",
        evidence: step.flag
          ? proofFor(state?.conflict?.kind)
          : (PROOFS[step.pick % PROOFS.length] ?? proofFor(undefined)),
      });
    case "Dismiss":
      return toConflict({
        _tag: "Dismiss",
        premise: PREMISE,
        effect: EFFECTS[step.pick % EFFECTS.length] ?? PREMISE,
      });
    case "Settle":
      // Without an escalation a quarter of the time: proven and dismissed need none.
      return toConflict({ _tag: "Settle", ...(step.flag ? { escalationId: ESCALATION } : {}) });
    case "Escalate":
      return toConflict({ _tag: "Escalate", escalationId: ESCALATION });
    case "Resolve":
      return toConflict({
        _tag: "Resolve",
        move: "escalate",
        ...(step.flag ? { decisionId: DECISION } : {}),
      });
    case "RecordCheck":
      return toConflict({
        _tag: "RecordCheck",
        world: WORLDS[step.world] ?? "A",
        check: `suite:${CHANGE_A}`,
        run: step.run,
        outcome: step.outcome,
        ...(step.outcome === "n/a" ? {} : { counts: { passed: 12, failed: 0, skipped: 1 } }),
        // Now and then an n/a cell that does not say why: refused as malformed.
        ...(step.flag ? { reason: "the suite's fixture is absent in this world" } : {}),
      });
    case "Draft":
      return toProbe({
        _tag: "Draft",
        conflictId: CONFLICT,
        attempts: plan.attempts,
        bundleHash: BUNDLE,
      });
    case "DraftFailed":
      // Now and then a failure that says why, so replay carries the detail through the wire.
      return toProbe({
        _tag: "DraftFailed",
        conflictId: CONFLICT,
        ...(plan.attempts % 2 === 0 ? { detail: "repairs-exhausted" as const } : {}),
      });
    case "Record": {
      const cell =
        step.mode === "progress"
          ? nextCell(state?.probe, plan)
          : { world: WORLDS[step.world] ?? "A", run: step.run, outcome: step.outcome };
      return toProbe({
        _tag: "Record",
        ...cell,
        resultRef: `r2://probe/${cell.run}/${cell.world}`,
        guardId: GUARD,
      });
    }
    case "Retire":
      return toProbe({ _tag: "Retire", decisionId: DECISION });
    case "RunFailed":
      return toProbe({ _tag: "RunFailed" });
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

/** The way forward from each state of the pair: the docs' happy paths and their exits. */
const progress = (state: Ledger | undefined): readonly Kind[] => {
  const probe = state?.probe?.state;
  switch (state?.conflict?.state) {
    case undefined:
      return ["Suspect"];
    case "suspected":
      return probe === undefined
        ? ["Draft", "Draft", "Draft", "Draft", "Draft", "Draft", "Prove", "Dismiss", "DraftFailed"]
        : ["Settle"];
    case "probing":
      return probe === "calibrating" ? ["Record"] : ["Settle"];
    // The suites' cells arrive after the probe has decided, so a decided conflict still takes them.
    case "proven":
      return ["Resolve", "Escalate", "Retire", "RecordCheck"];
    case "escalated":
      return ["Resolve", "RecordCheck"];
    default:
      return KINDS;
  }
};

const choose = (state: Ledger | undefined, plan: Plan, step: Step): LedgerCommand => {
  const choices = step.mode === "progress" ? progress(state) : KINDS;
  return build(choices[step.pick % choices.length] ?? "Suspect", state, plan, step);
};

export type Record_ = Played<Ledger, LedgerCommand, LedgerEvent>;

/** Every property draws the same plans from the same seed: play each one once. */
export const run = memo((plan: Plan): readonly Record_[] =>
  play(
    ledgerMachine,
    {
      start: T0,
      dt: () => 1,
      facts: (now) => ({ now }),
      every: (state, step) => EVERY.map((k) => build(k, state, plan, step)),
      choose: (state, step) => choose(state, plan, step),
    },
    plan.steps,
  ),
);

// ---------------------------------------------------------------- oracles

export type ConflictKey = "none" | ConflictState;
export type ProbeKey = "none" | ProbeState;

/** A suspicion the owning DO may open: parties, the kind's subject, a semantic predicate, and opinion only about semantics. */
const validSuspicion = (c: Extract<ConflictCommand, { _tag: "Suspect" }>): boolean =>
  c.parties.length > 0 &&
  new Set(c.parties).size === c.parties.length &&
  (c.kind === "semantic" || c.kind === "precedent") === (c.subjectId !== undefined) &&
  (c.kind !== "semantic" || c.predicate !== undefined) &&
  (c.origin !== "opinion" || c.kind === "semantic");

const PROOF_KIND: Readonly<Record<ProofWithoutProbe["_tag"], ConflictKind>> = {
  "merge-refused": "textual",
  guard: "precedent",
  interaction: "interaction",
};

/** The docs' Conflict table (state-machines.md § Conflict), typed independently of `decideConflict`. */
export const conflictOracle = (
  before: Ledger | undefined,
  command: ConflictCommand,
): ConflictKey | "refused" => {
  const conflict = before?.conflict;
  const probe = before?.probe;
  if (conflict === undefined)
    return command._tag === "Suspect" && validSuspicion(command) ? "suspected" : "refused";
  const ours = probe !== undefined && probe.conflictId === conflict.id;
  // A suite's cell is a fact of a conflict whose probe was drafted, in whatever state: it never moves it.
  if (command._tag === "RecordCheck") {
    const malformed =
      command.run < 1 ||
      command.run > 3 ||
      !command.check.startsWith("suite:chg_") ||
      (command.outcome === "n/a" && command.reason === undefined);
    const known = conflict.checks?.find(
      (c) => c.world === command.world && c.check === command.check && c.run === command.run,
    );
    return conflict.probeId === undefined ||
      malformed ||
      (known !== undefined && known.outcome !== command.outcome)
      ? "refused"
      : conflict.state;
  }
  switch (conflict.state) {
    case "suspected":
      if (command._tag === "Prove")
        return PROOF_KIND[command.evidence._tag] === conflict.kind ? "proven" : "refused";
      if (command._tag === "Dismiss") {
        const { outcome } = compare(command.premise, command.effect);
        return conflict.subjectId !== undefined &&
          conflict.origin !== "opinion" &&
          (conflict.predicate === undefined || conflict.predicate === command.premise.predicate) &&
          (outcome === "compatible" || outcome === "refines")
          ? "dismissed"
          : "refused";
      }
      if (command._tag === "Settle")
        return ours &&
          probe.state === "discarded" &&
          probe.discarded === "draft-failed" &&
          command.escalationId !== undefined
          ? "escalated"
          : "refused";
      return "refused";
    case "probing":
      if (command._tag !== "Settle" || !ours || probe.id !== conflict.probeId) return "refused";
      if (probe.state === "admitted") return "proven";
      if (probe.state === "discarded" && probe.discarded === "non-discriminating")
        return "dismissed";
      // Unstable, or a run that ended before the matrix was complete: unprovable either way.
      if (
        probe.state === "discarded" &&
        (probe.discarded === "unstable" || probe.discarded === "run-failed")
      )
        return command.escalationId === undefined ? "refused" : "escalated";
      return "refused";
    case "proven":
      return command._tag === "Escalate"
        ? "escalated"
        : command._tag === "Resolve"
          ? "resolved"
          : "refused";
    case "escalated":
      return command._tag === "Resolve" && command.decisionId !== undefined
        ? "resolved"
        : "refused";
    case "resolved":
    case "dismissed":
      return "refused";
    default: {
      const unreachable: never = conflict.state;
      return unreachable;
    }
  }
};

/** The docs' Probe → Guard table (state-machines.md), typed independently of `decideProbe`; `same` is a retried cell. */
export const probeOracle = (
  before: Ledger | undefined,
  command: ProbeCommand,
): ProbeKey | "refused" | "same" => {
  const conflict = before?.conflict;
  const probe = before?.probe;
  if (probe === undefined) {
    const awaiting = conflict?.state === "suspected" && conflict.probeId === undefined;
    const probeable = conflict?.premise !== undefined && conflict.effect !== undefined;
    if (command._tag === "Draft")
      return awaiting &&
        probeable &&
        command.attempts >= 1 &&
        command.attempts <= MAX_DRAFT_ATTEMPTS
        ? "calibrating"
        : "refused";
    return command._tag === "DraftFailed" && awaiting ? "discarded" : "refused";
  }
  switch (probe.state) {
    case "calibrating": {
      // A run that failed ends the probe wherever its matrix has got to.
      if (command._tag === "RunFailed")
        return conflict?.state === "probing" && conflict.probeId === probe.id
          ? "discarded"
          : "refused";
      if (command._tag !== "Record") return "refused";
      if (conflict?.state !== "probing" || conflict.probeId !== probe.id) return "refused";
      if (command.run < 1 || command.run > ADMISSION_RUNS) return "refused";
      const known = probe.cells.find((c) => c.world === command.world && c.run === command.run);
      if (known !== undefined) return known.outcome === command.outcome ? "same" : "refused";
      const admission = admit([
        ...probe.cells,
        { world: command.world, run: command.run, outcome: command.outcome },
      ]);
      return admission._tag === "admitted"
        ? "admitted"
        : admission._tag === "rejected"
          ? "discarded"
          : "calibrating";
    }
    case "admitted":
      return command._tag === "Retire" ? "retired" : "refused";
    case "discarded":
    case "retired":
      return "refused";
    default: {
      const unreachable: never = probe.state;
      return unreachable;
    }
  }
};

/** Each entity's own log, from the pair's: the events each one folds. */
export const conflictLog = (log: readonly Committed<LedgerEvent>[]): Committed<ConflictEvent>[] =>
  log.flatMap((c) => (foldsIntoConflict(c.payload) ? [{ at: c.at, payload: c.payload }] : []));
export const probeLog = (log: readonly Committed<LedgerEvent>[]): Committed<ProbeEvent>[] =>
  log.flatMap((c) => (foldsIntoProbe(c.payload) ? [{ at: c.at, payload: c.payload }] : []));

export const eventsIn = (r: Result.Result<readonly LedgerEvent[], { readonly _tag: string }>) =>
  Result.isSuccess(r) ? r.success : [];

// ------------------------------------------------------------- the wire

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
export const comparableConflict = (c: Conflict | undefined): string =>
  c === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Conflict)(c)));
export const comparableProbe = (p: Probe | undefined): string =>
  p === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Probe)(p)));

const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));
/** A log as storage hands it back: each payload encoded, through JSON, and decoded. */
export const throughTheWire = <E>(
  schema: Schema.Codec<E, unknown>,
  log: readonly Committed<E>[],
): Committed<E>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(schema)(c.payload) }))),
  ).map((w) => ({ at: Instant(w.at), payload: Schema.decodeUnknownSync(schema)(w.payload) }));

// ------------------------------------------------------------------ tour

const run3 = (cells: RunCells): readonly RunCells[] => [cells, cells, cells];
const GOOD: RunCells = { trunk: "pass", A: "pass", B: "n/a", AB: "fail", "A-noop": "fail" };
const VACUOUS: RunCells = { ...GOOD, "A-noop": "pass" };
/** A probe that admits, one that passes against the do-nothing mutant, and one that discriminates only sometimes. */
const MATRICES: readonly (readonly RunCells[])[] = [
  run3(GOOD),
  run3(VACUOUS),
  [GOOD, VACUOUS, GOOD],
];
const TOUR_PLANS: readonly Plan[] = (
  ["semantic", "textual", "precedent", "interaction"] as const
).flatMap((kind) =>
  MATRICES.map((matrix) => ({
    kind,
    origin: "fallout",
    fault: "none",
    propositions: "both",
    attempts: 1,
    matrix,
    steps: [],
  })),
);
const TOUR_STEPS: readonly Step[] = [0, 1, 2, 3, 4, 5].flatMap((pick) =>
  [true, false].map((flag) => ({
    mode: "progress",
    pick,
    world: 0,
    run: 1,
    outcome: "pass",
    flag,
  })),
);

/** The pair walked breadth-first: every command, for each kind of conflict and each kind of probe. */
let walked: readonly Fold<Ledger, LedgerEvent>[] | undefined;
export const ledgerTour = (): readonly Fold<Ledger, LedgerEvent>[] => {
  walked ??= tour(ledgerMachine, {
    start: T0,
    facts: (now) => ({ now }),
    moves: (state) =>
      TOUR_PLANS.flatMap((plan) =>
        EVERY.flatMap((kind) =>
          TOUR_STEPS.map((step) => ({ command: build(kind, state, plan, step), dt: 1 })),
        ),
      ),
    signature: (s) =>
      JSON.stringify([
        s?.conflict?.state,
        s?.conflict?.kind,
        s?.probe?.state,
        s?.probe?.discarded,
        s?.probe?.cells,
      ]),
    maxNodes: 5_000,
  });
  return walked;
};

export { ConflictEvent, ProbeEvent };
