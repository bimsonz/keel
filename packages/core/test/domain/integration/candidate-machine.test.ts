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
import { fc } from "../../support/fast-check.ts";

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
  assembled: ["StartVerification"],
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
    case "Verified":
      return { _tag: "Verified", verdictId: makeId("vrd", ulid(n)), ...fence };
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
    played.push({ before, probes, taken, log: [...log] });
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
    case "Verified":
      return before.state === "verifying" && fresh(command) ? "green" : "refused";
    case "Failed": {
      const a = command.attribution;
      const valid =
        a === "interaction" ||
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

describe("the Candidate machine", () => {
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
    expect(
      drive([form([A]), { _tag: "RefuseComposition", verdictId: makeId("vrd", ulid(3)) }]).state
        ?.state,
    ).toBe("red");
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
    fc.assert(
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
    fc.assert(
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
    fc.assert(
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
});
