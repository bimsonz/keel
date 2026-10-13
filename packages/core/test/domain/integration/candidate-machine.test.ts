import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Batch,
  type BatchAttribution,
  type CandidateCommand,
  CandidateEvent,
  decideCandidate,
  evolveCandidate,
  replayCandidate,
} from "../../../src/domain/integration/index.ts";
import {
  canonicalJson,
  type ChangeId,
  CommitSha,
  type Committed,
  ContentHash,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { candidateChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
import { type Fold, type Machine, tour } from "../../support/machine.ts";

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const BATCH = makeId("bat", ulid(1));
const PROJECT = makeId("prj", ulid(1));
const STRANGER = makeId("chg", ulid(999));
const SHA = CommitSha.make("a".repeat(40));
const PLAN = ContentHash.make(`sha256:${"0".repeat(64)}`);

type Kind = CandidateCommand["_tag"];
type Key = "none" | Batch["state"];
type Decision = ReturnType<typeof decideCandidate>;

const KINDS: readonly Kind[] = [
  "Form",
  "Assemble",
  "RefuseComposition",
  "StartVerification",
  "RefuseBundle",
  "Verified",
  "Failed",
  "Bisect",
  "Promote",
  "Invalidate",
];

/** The happy path out of each state, and the table's other exits (state-machines.md § Candidate). */
const PROGRESS: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Form"],
  forming: ["Assemble"],
  assembled: ["StartVerification"],
  verifying: ["Verified"],
  green: ["Promote"],
  red: ["Bisect"],
  bisected: KINDS,
  promoted: KINDS,
  invalidated: KINDS,
};
const SIDE: Readonly<Record<Key, readonly Kind[]>> = {
  none: ["Form"],
  forming: ["RefuseComposition"],
  assembled: ["RefuseBundle"],
  verifying: ["Failed", "Failed"],
  green: ["Invalidate"],
  red: ["Bisect"],
  bisected: KINDS,
  promoted: KINDS,
  invalidated: KINDS,
};

interface Step {
  readonly mode: "progress" | "side" | "any";
  readonly pick: number;
  readonly fenced: boolean;
  readonly blame: number;
}

const weighted = (yes: number, no: number): fc.Arbitrary<boolean> =>
  fc.oneof(
    { weight: yes, arbitrary: fc.constant(true) },
    { weight: no, arbitrary: fc.constant(false) },
  );

const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 5, arbitrary: fc.constant("progress" as const) },
    { weight: 3, arbitrary: fc.constant("side" as const) },
    { weight: 1, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
  fenced: weighted(1, 6),
  blame: fc.nat({ max: 5 }),
});

interface Plan {
  readonly members: readonly ChangeId[];
  readonly attempt: number;
  readonly chainEpoch: number;
  readonly steps: readonly Step[];
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  // Now and then an empty or oversized batch, or one naming a change twice, that must not form.
  members: fc.oneof(
    {
      weight: 8,
      arbitrary: fc
        .integer({ min: 1, max: 4 })
        .map((n) => Array.from({ length: n }, (_, i) => makeId("chg", ulid(i + 1)))),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        [],
        Array.from({ length: 17 }, (_, i) => makeId("chg", ulid(i + 1))),
        [makeId("chg", ulid(1)), makeId("chg", ulid(1))],
      ),
    },
  ),
  attempt: fc.integer({ min: 1, max: 3 }),
  chainEpoch: fc.integer({ min: 0, max: 3 }),
  steps: fc.array(stepArb, { minLength: 4, maxLength: 16 }),
});

const keyOf = (b: Batch | undefined): Key => b?.state ?? "none";
const bisectable = (b: Batch): boolean =>
  b.state === "red" && b.attribution === "unattributed" && b.members.length > 1;
const terminal = (b: Batch | undefined): boolean =>
  b !== undefined &&
  (b.state === "promoted" ||
    b.state === "invalidated" ||
    b.state === "bisected" ||
    (b.state === "red" && !bisectable(b)));

const blameFor = (state: Batch | undefined, plan: Plan, step: Step): BatchAttribution => {
  const members = state?.members ?? plan.members;
  const choices: readonly BatchAttribution[] = [
    members[step.pick % Math.max(1, members.length)] ?? STRANGER,
    "interaction",
    "infra",
    "unattributed",
    "unattributed",
    STRANGER,
  ];
  return choices[step.blame] ?? "infra";
};

/** A refused bundle's blame: a member, the infrastructure, or now and then a stranger. */
const bundleBlameFor = (state: Batch | undefined, plan: Plan, step: Step): ChangeId | "infra" => {
  const members = state?.members ?? plan.members;
  const choices: readonly (ChangeId | "infra")[] = [
    members[step.pick % Math.max(1, members.length)] ?? STRANGER,
    "infra",
    STRANGER,
  ];
  return choices[step.blame % choices.length] ?? "infra";
};

const build = (
  kind: Kind,
  state: Batch | undefined,
  plan: Plan,
  step: Step,
  n: number,
): CandidateCommand => {
  // A fenced result belongs to another attempt, or to another chain epoch.
  const stale = step.fenced ? (step.pick % 2 === 0 ? [1, 0] : [0, 1]) : [0, 0];
  const fence = {
    attempt: (state?.attempt ?? plan.attempt) + (stale[0] ?? 0),
    chainEpoch: (state?.chainEpoch ?? plan.chainEpoch) + (stale[1] ?? 0),
  };
  switch (kind) {
    case "Form":
      return {
        _tag: "Form",
        laneId: "lane:default",
        projectId: PROJECT,
        members: plan.members,
        base: SHA,
        predecessors: [],
        attempt: plan.attempt,
        chainEpoch: plan.chainEpoch,
      };
    case "Assemble":
      return {
        _tag: "Assemble",
        candidateId: makeId("cnd", ulid(n)),
        treeSha: CommitSha.make("b".repeat(40)),
        composer: "gitcore",
        tier: 0,
        tierReason: "clean merge-tree",
      };
    case "RefuseComposition":
      return { _tag: "RefuseComposition", verdictId: makeId("vrd", ulid(n)) };
    case "StartVerification":
      return { _tag: "StartVerification", instanceId: `verify-${n}`, planHash: PLAN };
    case "RefuseBundle":
      return {
        _tag: "RefuseBundle",
        verdictId: makeId("vrd", ulid(n)),
        attribution: bundleBlameFor(state, plan, step),
      };
    case "Verified":
      return {
        _tag: "Verified",
        verdictId: makeId("vrd", ulid(n)),
        // The verdict's flag by turn: absent, true or false.
        ...(n % 3 === 0 ? { verified: false } : n % 3 === 1 ? {} : { verified: true }),
        ...fence,
      };
    case "Failed":
      return {
        _tag: "Failed",
        verdictId: makeId("vrd", ulid(n)),
        attribution: blameFor(state, plan, step),
        ...fence,
      };
    case "Bisect":
      return { _tag: "Bisect", into: [makeId("bat", ulid(n)), makeId("bat", ulid(n + 1))] };
    case "Promote":
      return { _tag: "Promote", trunkSha: CommitSha.make("c".repeat(40)) };
    case "Invalidate":
      return { _tag: "Invalidate" };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

interface Probe {
  readonly command: CandidateCommand;
  readonly result: Decision;
  readonly after: Batch | undefined;
  readonly threw: boolean;
}

const attempt = (state: Batch | undefined, command: CandidateCommand, now: Instant): Probe => {
  const result = decideCandidate(state, command, { now, batchId: BATCH });
  if (Result.isFailure(result)) return { command, result, after: state, threw: false };
  try {
    return {
      command,
      result,
      after: result.success.reduce<Batch | undefined>(
        (s, payload) => evolveCandidate(s, { at: now, payload }),
        state,
      ),
      threw: false,
    };
  } catch (error) {
    if (!(error instanceof IllegalTransition)) throw error;
    return { command, result, after: state, threw: true };
  }
};

interface Played {
  readonly before: Batch | undefined;
  readonly now: Instant;
  readonly probes: readonly Probe[];
  readonly taken: Probe;
  readonly log: readonly Committed<CandidateEvent>[];
}

/** Plays a plan the way the Lane DO would, trying every command kind at each state on the way. */
const play = (plan: Plan): readonly Played[] => {
  const played: Played[] = [];
  const log: Committed<CandidateEvent>[] = [];
  let state: Batch | undefined;
  let n = 100;
  for (const step of plan.steps) {
    const now = Instant(T0 + played.length);
    const before = state;
    const probes = KINDS.map((k) => attempt(before, build(k, before, plan, step, (n += 2)), now));
    const choices =
      step.mode === "progress"
        ? PROGRESS[keyOf(before)]
        : step.mode === "side"
          ? SIDE[keyOf(before)]
          : KINDS;
    const taken = attempt(
      before,
      build(choices[step.pick % choices.length] ?? "Form", before, plan, step, (n += 2)),
      now,
    );
    if (Result.isSuccess(taken.result) && !taken.threw) {
      for (const payload of taken.result.success) log.push({ at: now, payload });
      state = taken.after;
    }
    played.push({ before, now, probes, taken, log: [...log] });
    if (taken.threw) break;
  }
  return played;
};

/** Every property draws the same plans from the same seed: play each one once. */
const traces = new Map<string, readonly Played[]>();
const run = (plan: Parameters<typeof play>[0]): readonly Played[] => {
  const key = JSON.stringify(plan);
  const known = traces.get(key);
  if (known !== undefined) return known;
  const trace = play(plan);
  traces.set(key, trace);
  return trace;
};

/** The docs' table, typed independently of `decideCandidate`: the state a command leads to, or `"refused"`. */
const oracle = (before: Batch | undefined, command: CandidateCommand): Key | "refused" => {
  if (before === undefined) {
    if (command._tag !== "Form") return "refused";
    const n = command.members.length;
    return n >= 1 && n <= 16 && new Set(command.members).size === n ? "forming" : "refused";
  }
  const fresh = (c: { readonly attempt: number; readonly chainEpoch: number }) =>
    c.attempt === before.attempt && c.chainEpoch === before.chainEpoch;
  switch (command._tag) {
    case "Form":
      return "refused";
    case "Assemble":
      return before.state === "forming" ? "assembled" : "refused";
    case "RefuseComposition":
      return before.state === "forming" ? "red" : "refused";
    case "StartVerification":
      return before.state === "assembled" ? "verifying" : "refused";
    case "RefuseBundle": {
      const a = command.attribution;
      const valid = a === "infra" || before.members.some((m) => m === a);
      return before.state === "assembled" && valid ? "red" : "refused";
    }
    case "Verified":
      return before.state === "verifying" && fresh(command) ? "green" : "refused";
    case "Failed": {
      const a = command.attribution;
      const valid =
        (a === "interaction" && before.members.length > 1) ||
        a === "infra" ||
        (a === "unattributed" && before.members.length > 1) ||
        before.members.some((m) => m === a);
      return before.state === "verifying" && fresh(command) && valid ? "red" : "refused";
    }
    case "Bisect":
      return bisectable(before) ? "bisected" : "refused";
    case "Promote":
      return before.state === "green" ? "promoted" : "refused";
    case "Invalidate":
      return before.state === "green" ? "invalidated" : "refused";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const comparable = (b: Batch | undefined): string =>
  b === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Batch)(b)));
const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));
const throughTheWire = (log: readonly Committed<CandidateEvent>[]): Committed<CandidateEvent>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(CandidateEvent)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(CandidateEvent)(w.payload),
  }));

const failureTag = (r: Decision | undefined): string | undefined =>
  r !== undefined && Result.isFailure(r) ? r.failure._tag : undefined;
const eventsOf = (r: Decision): readonly CandidateEvent[] => (Result.isSuccess(r) ? r.success : []);

/** Drives one explicit scenario from no batch. */
const drive = (commands: readonly CandidateCommand[]) => {
  let state: Batch | undefined;
  const results: Decision[] = [];
  for (const command of commands) {
    const p = attempt(state, command, T0);
    results.push(p.result);
    state = p.after;
  }
  return { state, results };
};

const A = makeId("chg", ulid(1));
const B = makeId("chg", ulid(2));
const form = (members: readonly ChangeId[]): CandidateCommand => ({
  _tag: "Form",
  laneId: "lane:default",
  projectId: PROJECT,
  members,
  base: SHA,
  predecessors: [],
  attempt: 1,
  chainEpoch: 0,
});
const assemble: CandidateCommand = {
  _tag: "Assemble",
  candidateId: makeId("cnd", ulid(1)),
  treeSha: SHA,
  composer: "gitcore",
  tier: 0,
  tierReason: "clean",
};
const start: CandidateCommand = {
  _tag: "StartVerification",
  instanceId: "verify-1",
  planHash: PLAN,
};
const verified: CandidateCommand = {
  _tag: "Verified",
  verdictId: makeId("vrd", ulid(1)),
  attempt: 1,
  chainEpoch: 0,
};
const failed = (attribution: BatchAttribution, attemptNo = 1): CandidateCommand => ({
  _tag: "Failed",
  verdictId: makeId("vrd", ulid(2)),
  attribution,
  attempt: attemptNo,
  chainEpoch: 0,
});
const bisect: CandidateCommand = {
  _tag: "Bisect",
  into: [makeId("bat", ulid(2)), makeId("bat", ulid(3))],
};
const refuseComposition: CandidateCommand = {
  _tag: "RefuseComposition",
  verdictId: makeId("vrd", ulid(3)),
};
const refuseBundle = (attribution: ChangeId | "infra"): CandidateCommand => ({
  _tag: "RefuseBundle",
  verdictId: makeId("vrd", ulid(4)),
  attribution,
});

/**
 * Each property plays hundreds of seeded runs through decide and evolve. Run
 * alone one takes about 1.5 s; inside the full unit suite on a busy runner it
 * has passed vitest's 5 s default, so it gets the arch tests' limit instead of
 * fewer runs (fewer runs would weaken every mutant's proof).
 */
const PROPERTY_TIMEOUT = 60_000;

describe("the Candidate machine", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[candidate.transitions] in every state a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          r.probes.every((p) => {
            const expected = oracle(r.before, p.command);
            return expected === "refused"
              ? Result.isFailure(p.result)
              : Result.isSuccess(p.result) && !p.threw && keyOf(p.after) === expected;
          }),
        ),
      ),
    );
    // L1's path: a batch of one, formed, assembled by GitCore, verified green, promoted when trunk advances.
    const l1 = drive([form([A]), assemble, start, verified, { _tag: "Promote", trunkSha: SHA }]);
    expect(l1.state?.state).toBe("promoted");
    expect(drive([form([A]), refuseComposition]).state?.state).toBe("red");
    // A batch of one's failure is its member's: neither an interaction nor unattributed.
    expect(failureTag(drive([form([A]), assemble, start, failed("interaction")]).results[3])).toBe(
      "InvalidBatch",
    );
  });

  it("[candidate.one-terminal] a batch ends at most once, and a terminal batch takes no command", () => {
    let ended = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) => {
          if (!terminal(r.before)) return true;
          ended++;
          return r.probes.every((p) => Result.isFailure(p.result));
        }),
      ),
    );
    expect(ended).toBeGreaterThan(0);
    const red = drive([form([A]), assemble, start, failed(A), { _tag: "Promote", trunkSha: SHA }]);
    expect(red.state?.state).toBe("red");
    expect(failureTag(red.results[4])).toBe("CandidateStateRefused");
  });

  it("[candidate.replay] at every step, the events so far, through the wire, replay to the same batch", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every(
          (r) =>
            comparable(replayCandidate(throughTheWire(r.log))) ===
            comparable(r.taken.threw ? r.before : (r.taken.after ?? r.before)),
        ),
      ),
    );
    const green = drive([form([A, B]), assemble, start, verified]);
    expect(green.state?.state).toBe("green");
  });

  it("[candidate.decide-evolvable] evolve takes every event decide emits", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    expect(() =>
      evolveCandidate(undefined, {
        at: T0,
        payload: {
          _tag: "CandidateInvalidated",
          candidateId: makeId("cnd", ulid(1)),
          batchId: BATCH,
          reason: "head-moved",
        },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[candidate.fenced] a result for another attempt or chain epoch is refused and changes nothing", () => {
    let fencedSeen = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          r.probes
            .filter(() => r.before?.state === "verifying")
            .every((p) => {
              const c = p.command;
              if (c._tag !== "Verified" && c._tag !== "Failed") return true;
              if (c.attempt === r.before?.attempt && c.chainEpoch === r.before.chainEpoch)
                return true;
              fencedSeen++;
              return failureTag(p.result) === "ResultFenced" && p.after === r.before;
            }),
        ),
      ),
    );
    expect(fencedSeen).toBeGreaterThan(0);
    const late = drive([form([A]), assemble, start, { ...verified, chainEpoch: 1 }]);
    expect(failureTag(late.results[3])).toBe("ResultFenced");
    expect(late.state?.state).toBe("verifying");
  });

  it("[candidate.bisect-only-unattributed] only a multi-change failure nobody is blamed for is bisected", () => {
    let bisected = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          r.probes
            .filter((p) => p.command._tag === "Bisect")
            .every((p) => {
              const allowed = r.before !== undefined && bisectable(r.before);
              if (allowed) bisected++;
              return allowed === Result.isSuccess(p.result);
            }),
        ),
      ),
    );
    expect(bisected).toBeGreaterThan(0);
    expect(
      drive([form([A, B]), assemble, start, failed("unattributed"), bisect]).state?.state,
    ).toBe("bisected");
    expect(failureTag(drive([form([A, B]), assemble, start, failed(A), bisect]).results[4])).toBe(
      "CandidateStateRefused",
    );
  });

  it("[candidate.attribution-is-member] a failure is blamed on a member, a kind, or nobody yet, never on a stranger", () => {
    let strangers = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          r.probes.every((p) => {
            const blamed = eventsOf(p.result).flatMap((e) =>
              e._tag === "BatchFailed" ? [e.attribution] : [],
            );
            if (
              p.command._tag === "Failed" &&
              p.command.attribution === STRANGER &&
              r.before?.state === "verifying"
            )
              strangers++;
            return blamed.every(
              (a) =>
                a === "textual" ||
                a === "interaction" ||
                a === "infra" ||
                a === "unattributed" ||
                (r.before?.members.includes(a) ?? false),
            );
          }),
        ),
      ),
    );
    expect(strangers).toBeGreaterThan(0);
    expect(failureTag(drive([form([A]), assemble, start, failed(STRANGER)]).results[3])).toBe(
      "InvalidBatch",
    );
  });

  it("[candidate.bundle-refused] a bundle refused for an assembled batch turns it Red, blamed on a member or the infrastructure, and is never bisected", () => {
    let refused = 0;
    let strangers = 0;
    assertReaching(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          r.probes.every((p) => {
            const c = p.command;
            const before = r.before;
            if (c._tag !== "RefuseBundle" || before === undefined) return true;
            const a = c.attribution;
            const valid =
              before.state === "assembled" && (a === "infra" || before.members.includes(a));
            if (before.state === "assembled" && !valid) strangers++;
            if (!valid) return Result.isFailure(p.result);
            refused++;
            const events = eventsOf(p.result);
            const e = events[0];
            return (
              events.length === 1 &&
              e?._tag === "BatchFailed" &&
              e.attribution === a &&
              e.verdictId === c.verdictId &&
              e.candidateId === before.candidateId &&
              p.after?.state === "red" &&
              !bisectable(p.after) &&
              terminal(p.after)
            );
          }),
        ),
      ),
    );
    expect(refused).toBeGreaterThan(0);
    expect(strangers).toBeGreaterThan(0);
    // A symlink in the bundle, introduced by B's restacked commit: B is blamed, and nothing is bisected.
    const blamed = drive([form([A, B]), assemble, refuseBundle(B), bisect]);
    expect(blamed.state).toMatchObject({ state: "red", attribution: B });
    expect(failureTag(blamed.results[3])).toBe("CandidateStateRefused");
    expect(drive([form([A, B]), assemble, refuseBundle("infra")]).state?.attribution).toBe("infra");
    expect(failureTag(drive([form([A]), assemble, refuseBundle(STRANGER)]).results[2])).toBe(
      "InvalidBatch",
    );
    expect(failureTag(drive([form([A]), assemble, start, refuseBundle(A)]).results[3])).toBe(
      "CandidateStateRefused",
    );
  });

  it("[candidate.refused-composition-blames] a refused composition is blamed on the sole member of a batch of one, and is textual for a larger batch", () => {
    let single = 0;
    let larger = 0;
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every((r) =>
          r.probes.every((p) => {
            const before = r.before;
            if (p.command._tag !== "RefuseComposition" || before?.state !== "forming") return true;
            const expected = before.members.length === 1 ? before.members[0] : "textual";
            if (before.members.length === 1) single++;
            else larger++;
            const blamed = eventsOf(p.result).flatMap((e) =>
              e._tag === "BatchFailed" ? [e.attribution] : [],
            );
            return (
              blamed.length === 1 && blamed[0] === expected && p.after?.attribution === expected
            );
          }),
        ),
      ),
    );
    expect(single).toBeGreaterThan(0);
    expect(larger).toBeGreaterThan(0);
    // A batch of one whose merge is refused names its change, so the Change DO bounces it.
    expect(drive([form([A]), refuseComposition]).state).toMatchObject({
      state: "red",
      attribution: A,
    });
    expect(drive([form([A, B]), refuseComposition]).state).toMatchObject({
      state: "red",
      attribution: "textual",
    });
  });
});

// The chart checks the machine; it never drives it.

const candidateMachine: Machine<
  Batch,
  CandidateCommand,
  CandidateEvent,
  { readonly now: Instant; readonly batchId: typeof BATCH }
> = { decide: decideCandidate, evolve: evolveCandidate };

const candidateView: View<Batch, CandidateEvent> = {
  from: (f) => keyOf(f.before),
  to: (f) => keyOf(f.after),
};

const TOUR_PLAN: Plan = { members: [A, B], attempt: 1, chainEpoch: 0, steps: [] };

/** The machine walked breadth-first: every command kind, with every kind of blame. */
let walkedTour: readonly Fold<Batch, CandidateEvent>[] | undefined;
const candidateTour = (): readonly Fold<Batch, CandidateEvent>[] => {
  if (walkedTour !== undefined) return walkedTour;
  let n = 100;
  walkedTour = tour(candidateMachine, {
    start: T0,
    facts: (now) => ({ now, batchId: BATCH }),
    moves: (state) =>
      KINDS.flatMap((kind) =>
        [0, 1, 2, 3, 4, 5].map((blame) => ({
          command: build(
            kind,
            state,
            TOUR_PLAN,
            { mode: "progress", pick: 0, fenced: false, blame },
            (n += 2),
          ),
          dt: 1,
        })),
      ),
    signature: (b) => `${keyOf(b)}|${b?.attribution ?? ""}`,
  });
  return walkedTour;
};

/** The same walk for a batch of one, where the sole member may be blamed before anything ran. */
const soloTour = (): readonly Fold<Batch, CandidateEvent>[] => {
  let n = 500;
  return tour(candidateMachine, {
    start: T0,
    facts: (now) => ({ now, batchId: BATCH }),
    moves: (state) =>
      KINDS.flatMap((kind) =>
        [0, 1, 2, 3, 4, 5].map((blame) => ({
          command: build(
            kind,
            state,
            { ...TOUR_PLAN, members: [A] },
            { mode: "progress", pick: 0, fenced: false, blame },
            (n += 2),
          ),
          dt: 1,
        })),
      ),
    signature: (b) => `${keyOf(b)}|${b?.attribution ?? ""}`,
  });
};

const ANOTHER_BATCH = makeId("bat", ulid(2));
const BLAMES: readonly BatchAttribution[] = [
  "textual",
  "interaction",
  "infra",
  "unattributed",
  A,
  B,
];

/** What the fold's table is about: whose the batch is, its state, its members and who is blamed. */
interface Folded {
  readonly id: Batch["id"];
  readonly state: Batch["state"];
  readonly members: readonly ChangeId[];
  readonly attribution?: BatchAttribution;
}

/** Which blame a failure may carry from each state (state-machines.md § Candidate). */
const blamed = (from: Folded, blame: BatchAttribution): boolean => {
  const named = !["textual", "interaction", "infra", "unattributed"].includes(blame);
  if (from.state === "forming")
    return blame === "textual" || (from.members.length === 1 && blame === from.members[0]);
  if (from.state === "assembled") return named || blame === "infra";
  return from.state === "verifying" && blame !== "textual";
};

/** The fold's from-table (state-machines.md § Candidate), typed apart from `evolveCandidate`. */
const folds = (from: Folded | undefined, event: CandidateEvent): Folded | "illegal" => {
  if (from === undefined)
    return event._tag === "BatchFormed" && event.projectId !== undefined
      ? { id: event.batchId, state: "forming", members: event.members }
      : "illegal";
  if (event._tag === "BatchFormed" || event.batchId !== from.id) return "illegal";
  const moves = (state: Batch["state"], to: Batch["state"]): Folded | "illegal" =>
    from.state === state ? { ...from, state: to } : "illegal";
  switch (event._tag) {
    case "CandidateAssembled":
      return moves("forming", "assembled");
    case "VerificationStarted":
      return moves("assembled", "verifying");
    case "BatchVerified":
      return moves("verifying", "green");
    case "BatchFailed":
      return blamed(from, event.attribution)
        ? { ...from, state: "red", attribution: event.attribution }
        : "illegal";
    case "CandidateBisected":
      return from.state === "red" && from.attribution === "unattributed" && from.members.length > 1
        ? { ...from, state: "bisected" }
        : "illegal";
    case "CandidatePromoted":
      return moves("green", "promoted");
    case "CandidateInvalidated":
      return moves("green", "invalidated");
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

describe("the Candidate fold", () => {
  it("[candidate.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const cases = foldCases<Batch, CandidateEvent, Folded>({
      evolve: evolveCandidate,
      walked: [...candidateTour(), ...soloTour()],
      summary: (b) => ({
        id: b.id,
        state: b.state,
        members: b.members,
        ...(b.attribution === undefined ? {} : { attribution: b.attribution }),
      }),
      shown: (f) =>
        `${f.id} ${f.state} of ${f.members.length}${f.attribution === undefined ? "" : `, blaming ${f.attribution}`}`,
      // Each event as committed and as another batch's; a forming that names no project;
      // and a failure with every blame there is.
      forms: (event) => [
        event,
        { ...event, batchId: ANOTHER_BATCH },
        ...(event._tag === "BatchFormed" ? [{ ...event, projectId: undefined }] : []),
        ...(event._tag === "BatchFailed"
          ? BLAMES.map((attribution) => ({ ...event, attribution }))
          : []),
      ],
      times: [T0],
      table: folds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Twenty-one rows, a batch of two and a batch of one in every state each reaches, by
    // every event the two walks committed in each of its forms.
    expect(foldShape(cases)).toEqual({
      folds: 6027,
      refused: 5424,
      rows: [
        "none",
        `${BATCH} forming of 2`,
        `${BATCH} assembled of 2`,
        `${BATCH} red of 2, blaming textual`,
        `${BATCH} verifying of 2`,
        `${BATCH} red of 2, blaming ${A}`,
        `${BATCH} red of 2, blaming infra`,
        `${BATCH} green of 2`,
        `${BATCH} red of 2, blaming interaction`,
        `${BATCH} red of 2, blaming unattributed`,
        `${BATCH} promoted of 2`,
        `${BATCH} invalidated of 2`,
        `${BATCH} bisected of 2, blaming unattributed`,
        `${BATCH} forming of 1`,
        `${BATCH} assembled of 1`,
        `${BATCH} red of 1, blaming ${A}`,
        `${BATCH} verifying of 1`,
        `${BATCH} red of 1, blaming infra`,
        `${BATCH} green of 1`,
        `${BATCH} promoted of 1`,
        `${BATCH} invalidated of 1`,
      ],
    });
  });
});

describe("the Candidate chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[candidate.chart] every state change a run makes is an edge of the Candidate chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (plan) =>
        run(plan).every(
          (r) =>
            offChart(
              candidateChart,
              foldsOf(
                candidateMachine,
                r.before,
                [r.taken.result, ...r.probes.map((p) => p.result)],
                r.now,
              ),
              candidateView,
            ).length === 0,
        ),
      ),
    );
    const walked = candidateTour();
    expect(offChart(candidateChart, walked, candidateView)).toEqual([]);
    expect(uncovered(candidateChart, walked, candidateView)).toEqual([]);
  });
});
