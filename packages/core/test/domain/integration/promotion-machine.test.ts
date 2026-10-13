import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Batch,
  type CandidateCommand,
  type CandidateEvent,
  commutation,
  type CommutationFacts,
  decideCandidate,
  decidePromotion,
  evolveCandidate,
  evolvePromotion,
  type Footprints,
  type MemberCommit,
  type PendingGroup,
  type PromotionCommand,
  PromotionFrozen,
  replayPromotion,
  Trunk,
  TrunkEvent,
} from "../../../src/domain/integration/index.ts";
import {
  type BatchId,
  canonicalJson,
  type ChangeId,
  CommitSha,
  type Committed,
  ContentHash,
  Glob,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
  userActor,
} from "../../../src/domain/kernel/index.ts";
import { promotionChart } from "../../charts/charts.ts";
import { foldsOf, offChart, uncovered, type View } from "../../charts/conformance.ts";
import { fc } from "../../support/fast-check.ts";
import { foldCases, foldLines, foldShape } from "../../support/fold-table.ts";
import { type Fold, type Machine, tour } from "../../support/machine.ts";
import { assertReaching } from "../../support/reach.ts";

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const PROJECT = makeId("prj", ulid(1));
/** Whoever releases a freeze: a person, named as a command names one. */
const RELEASER = userActor(makeId("usr", ulid(1)));
const sha = (n: number): CommitSha => CommitSha.make(n.toString(16).padStart(40, "0"));
const H0 = sha(1);
const STRAY = sha(0xdead);
const PATHS = ["src/a.ts", "src/b.ts", "src/c.ts", "pnpm-lock.yaml"] as const;
const BARRIERS = [Glob.make("pnpm-lock.yaml")];
/** Each member's commit on trunk, as an honest composer reports it: one per change, fixed by its id. */
const memberSha = (changeId: ChangeId): CommitSha =>
  CommitSha.make(changeId.slice(-26).padStart(40, "e"));
const membersOf = (wal: PendingGroup | undefined): readonly ChangeId[] =>
  (wal?.batches ?? []).flatMap((b) => b.members);
const commitsFor = (members: readonly ChangeId[]): readonly MemberCommit[] =>
  members.map((changeId) => ({ changeId, commitSha: memberSha(changeId) }));
/** A composer's report names exactly the group's members, in the group's order. */
const matchesGroup = (commits: readonly MemberCommit[], wal: PendingGroup): boolean =>
  commits.map((c) => c.changeId).join() === membersOf(wal).join();

type Kind = PromotionCommand["_tag"];
type Phase = "none" | Trunk["phase"];
type Decision = ReturnType<typeof decidePromotion>;

const KINDS: readonly Kind[] = [
  "Initialize",
  "Enqueue",
  "Flush",
  "Composed",
  "ReadBack",
  "PushRefused",
  "Resume",
];
const PROGRESS: Readonly<Record<Phase, readonly Kind[]>> = {
  none: ["Initialize"],
  idle: ["Enqueue"],
  debouncing: ["Flush", "Flush", "Enqueue"],
  promoting: ["Composed", "ReadBack", "ReadBack", "PushRefused", "Enqueue"],
  frozen: ["Resume", "Enqueue"],
};

interface Step {
  readonly mode: "progress" | "any";
  readonly pick: number;
  /** Mostly the expected value; now and then a stray one. */
  readonly honest: boolean;
  readonly path: number;
  readonly behind: boolean;
}

const weighted = (yes: number, no: number): fc.Arbitrary<boolean> =>
  fc.oneof(
    { weight: yes, arbitrary: fc.constant(true) },
    { weight: no, arbitrary: fc.constant(false) },
  );

const stepArb: fc.Arbitrary<Step> = fc.record({
  mode: fc.oneof(
    { weight: 5, arbitrary: fc.constant("progress" as const) },
    { weight: 1, arbitrary: fc.constant("any" as const) },
  ),
  pick: fc.nat(),
  honest: weighted(7, 1),
  path: fc.nat({ max: PATHS.length - 1 }),
  behind: weighted(1, 4),
});

const planArb = fc.array(stepArb, { minLength: 6, maxLength: 40 });

/** A verdict's `verified` flag by turn: absent, true or false, so replay carries all three. */
const flagOf = (n: number): { readonly verified?: boolean } =>
  n % 3 === 0 ? { verified: false } : n % 3 === 1 ? {} : { verified: true };

interface World {
  /** What each batch touched, as its facts will report at the flush. */
  readonly touched: Map<string, string>;
  /** Batches verified on an older base, whose intervening changes overlap them. */
  readonly behind: Set<string>;
  n: number;
}

const footprints = (changes: readonly ChangeId[], paths: readonly string[]): Footprints => ({
  changes,
  paths,
  affected: paths,
  subjects: [],
});

const factsFor = (trunk: Trunk, world: World): CommutationFacts[] =>
  trunk.queue.map((b) => {
    const path = world.touched.get(b.batchId) ?? "src/a.ts";
    return {
      batchId: b.batchId,
      touched: footprints(b.members, [path]),
      intervening: world.behind.has(b.batchId)
        ? footprints([makeId("chg", ulid(900))], [path])
        : footprints([], []),
      mergeTreeClean: true,
    };
  });

const build = (
  kind: Kind,
  state: Trunk | undefined,
  step: Step,
  world: World,
): PromotionCommand => {
  world.n += 1;
  const n = world.n;
  switch (kind) {
    case "Initialize":
      return { _tag: "Initialize", head: H0, by: "seed" };
    case "Enqueue": {
      const batchId = makeId("bat", ulid(n));
      world.touched.set(batchId, PATHS[step.path] ?? "src/a.ts");
      if (step.behind) world.behind.add(batchId);
      // Now and then a batch speculated on a change trunk does not hold yet: it must wait.
      const predecessors = !step.honest ? [makeId("chg", ulid(800 + n))] : [];
      return {
        _tag: "Enqueue",
        batchId,
        candidateId: makeId("cnd", ulid(n)),
        verdictId: makeId("vrd", ulid(n)),
        // Now and then a batch of two, so a member's place in the group is not its batch's.
        members:
          n % 3 === 0
            ? [makeId("chg", ulid(n)), makeId("chg", ulid(400_000 + n))]
            : [makeId("chg", ulid(n))],
        base: state?.head ?? H0,
        predecessors,
        ...flagOf(n),
      };
    }
    case "Flush":
      return {
        _tag: "Flush",
        observedHead: step.honest ? (state?.head ?? H0) : STRAY,
        groupId: `group-${n}`,
        committerTime: Instant(T0 + n),
        barriers: BARRIERS,
        inputs: state === undefined ? [] : factsFor(state, world),
      };
    case "Composed": {
      const honest = commitsFor(membersOf(state?.wal));
      return {
        _tag: "Composed",
        sha: step.honest ? (state?.wal?.composed ?? sha(0x1000 + n)) : sha(0x2000 + n),
        // Now and then a composer that reports a chain other than the group's.
        commits:
          step.honest || step.pick % 2 === 0
            ? honest
            : honest.length > 1
              ? honest.toReversed()
              : [],
      };
    }
    case "ReadBack": {
      const wal = state?.wal;
      const observed = !step.honest
        ? STRAY
        : step.pick % 3 === 0
          ? (wal?.old ?? H0)
          : (wal?.composed ?? H0);
      return { _tag: "ReadBack", observed };
    }
    case "PushRefused": {
      const wal = state?.wal;
      return {
        _tag: "PushRefused",
        reason: step.path % 2 === 0 ? "pack-too-large" : "repo-bytes-quota",
        // Mostly the old head, as a refused push leaves it; now and then the composed SHA or a stray one.
        observed: step.honest
          ? (wal?.old ?? H0)
          : step.pick % 2 === 0
            ? (wal?.composed ?? STRAY)
            : STRAY,
      };
    }
    case "Resume":
      return {
        _tag: "Resume",
        by: RELEASER,
        head: state?.frozen?.observed ?? state?.head ?? H0,
      };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

interface Probe {
  readonly command: PromotionCommand;
  readonly result: Decision;
  readonly after: Trunk | undefined;
  readonly threw: boolean;
}

const attempt = (state: Trunk | undefined, command: PromotionCommand, now: Instant): Probe => {
  const result = decidePromotion(state, command, { now, projectId: PROJECT });
  if (Result.isFailure(result)) return { command, result, after: state, threw: false };
  try {
    return {
      command,
      result,
      after: result.success.reduce<Trunk | undefined>(
        (s, payload) => evolvePromotion(s, { at: now, payload }),
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
  readonly before: Trunk | undefined;
  readonly now: Instant;
  readonly probes: readonly Probe[];
  readonly taken: Probe;
  readonly after: Trunk | undefined;
  readonly log: readonly Committed<TrunkEvent>[];
}

/** Plays a plan the way the Trunk DO would, trying every command kind at each phase on the way. */
const play = (steps: readonly Step[]): readonly Played[] => {
  const world: World = { touched: new Map(), behind: new Set(), n: 100 };
  const played: Played[] = [];
  const log: Committed<TrunkEvent>[] = [];
  let state: Trunk | undefined;
  for (const step of steps) {
    const now = Instant(T0 + played.length);
    const before = state;
    const probes = KINDS.map((k) => attempt(before, build(k, before, step, world), now));
    const choices = step.mode === "progress" ? PROGRESS[before?.phase ?? "none"] : KINDS;
    const taken = attempt(
      before,
      build(choices[step.pick % choices.length] ?? "Enqueue", before, step, world),
      now,
    );
    if (Result.isSuccess(taken.result) && !taken.threw) {
      for (const payload of taken.result.success) log.push({ at: now, payload });
      state = taken.after;
    }
    played.push({ before, now, probes, taken, after: state, log: [...log] });
    if (taken.threw) break;
  }
  return played;
};

/** Every property draws the same plans from the same seed: play each one once. */
const traces = new Map<string, readonly Played[]>();
const run = (steps: Parameters<typeof play>[0]): readonly Played[] => {
  const key = JSON.stringify(steps);
  const known = traces.get(key);
  if (known !== undefined) return known;
  const trace = play(steps);
  traces.set(key, trace);
  return trace;
};

/** What `commutation` says of each queued batch at a flush, FIFO: the group, the declined, and where it stopped. */
const expectedFlush = (trunk: Trunk, command: Extract<PromotionCommand, { _tag: "Flush" }>) => {
  const group: {
    readonly id: BatchId;
    readonly touched: Footprints;
    readonly members: readonly ChangeId[];
  }[] = [];
  const declined: BatchId[] = [];
  for (const b of trunk.queue) {
    const facts = command.inputs.find((i) => i.batchId === b.batchId);
    if (facts === undefined) break;
    const out = commutation({
      batch: { id: b.batchId, base: b.base, predecessors: b.predecessors, touched: facts.touched },
      intervening: facts.intervening,
      head: trunk.head,
      promoted: [...trunk.promoted, ...group.flatMap((g) => g.members)],
      mergeTreeClean: facts.mergeTreeClean,
      barriers: command.barriers,
      group: group.map((g) => ({ id: g.id, touched: g.touched })),
    });
    if (out._tag === "wait") break;
    if (out._tag === "reverify") declined.push(b.batchId);
    else {
      group.push({ id: b.batchId, touched: facts.touched, members: b.members });
      // After a group's pack was refused as too large, a group is one batch until a push lands.
      if (trunk.solo === true) break;
    }
  }
  return { group: group.map((g) => g.id), declined };
};

const settled = (t: Trunk, removed: number): Phase =>
  t.queue.length - removed === 0 ? "idle" : "debouncing";

/** The docs' table (state-machines.md § Promotion, ADR 0003), typed independently of `decidePromotion`. */
const oracle = (
  before: Trunk | undefined,
  command: PromotionCommand,
): Phase | "refused" | "noop" => {
  if (before === undefined) return command._tag === "Initialize" ? "idle" : "refused";
  const wal = before.wal;
  switch (command._tag) {
    case "Initialize":
      return "refused";
    case "Enqueue":
      return [...before.queue, ...(wal?.batches ?? [])].some((b) => b.batchId === command.batchId)
        ? "refused"
        : before.phase === "idle"
          ? "debouncing"
          : before.phase;
    case "Flush": {
      if (before.phase !== "debouncing") return "refused";
      if (command.observedHead !== before.head) return "frozen";
      const { group, declined } = expectedFlush(before, command);
      if (group.length > 0) return "promoting";
      return declined.length === 0 ? "noop" : settled(before, declined.length);
    }
    case "Composed":
      if (before.phase !== "promoting" || wal === undefined) return "refused";
      if (!matchesGroup(command.commits, wal)) return "refused";
      if (wal.composed === undefined) return "promoting";
      return command.sha === wal.composed ? "noop" : "frozen";
    case "ReadBack":
      if (before.phase !== "promoting" || wal?.composed === undefined) return "refused";
      if (command.observed === wal.old) return "noop";
      return command.observed === wal.composed ? settled(before, 0) : "frozen";
    case "PushRefused":
      // Only once composed, and only with trunk still on the old head: the group ends, declined.
      return before.phase === "promoting" &&
        wal?.composed !== undefined &&
        command.observed === wal.old
        ? settled(before, 0)
        : "refused";
    case "Resume":
      return before.phase === "frozen" ? settled(before, 0) : "refused";
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const comparable = (t: Trunk | undefined): string =>
  t === undefined ? "none" : canonicalJson(asJson(Schema.encodeSync(Trunk)(t)));
const Wire = Schema.Array(Schema.Struct({ at: Schema.Number, payload: Schema.Unknown }));
const throughTheWire = (log: readonly Committed<TrunkEvent>[]): Committed<TrunkEvent>[] =>
  Schema.decodeUnknownSync(Wire)(
    asJson(log.map((c) => ({ at: c.at, payload: Schema.encodeSync(TrunkEvent)(c.payload) }))),
  ).map((w) => ({
    at: Instant(w.at),
    payload: Schema.decodeUnknownSync(TrunkEvent)(w.payload),
  }));

const eventsOf = (r: Decision): readonly TrunkEvent[] => (Result.isSuccess(r) ? r.success : []);
const tagsOf = (r: Decision): string[] => eventsOf(r).map((e) => e._tag);
const failureTag = (r: Decision | undefined): string | undefined =>
  r !== undefined && Result.isFailure(r) ? r.failure._tag : undefined;

/** Drives one explicit scenario. */
const drive = (commands: readonly PromotionCommand[]) => {
  let state: Trunk | undefined;
  const results: Decision[] = [];
  for (const command of commands) {
    const p = attempt(state, command, T0);
    results.push(p.result);
    state = p.after;
  }
  return { state, results, tags: results.map(tagsOf) };
};

const init: PromotionCommand = { _tag: "Initialize", head: H0, by: "seed" };
const C1 = makeId("chg", ulid(1));
const C2 = makeId("chg", ulid(2));
const enqueue = (
  n: number,
  member: ChangeId,
  predecessors: readonly ChangeId[] = [],
): PromotionCommand => ({
  _tag: "Enqueue",
  batchId: makeId("bat", ulid(n)),
  candidateId: makeId("cnd", ulid(n)),
  verdictId: makeId("vrd", ulid(n)),
  members: [member],
  base: H0,
  predecessors,
});
const facts = (n: number, member: ChangeId, path: string): CommutationFacts => ({
  batchId: makeId("bat", ulid(n)),
  touched: footprints([member], [path]),
  intervening: footprints([], []),
  mergeTreeClean: true,
});
const flush = (
  inputs: readonly CommutationFacts[],
  observedHead: CommitSha = H0,
  groupId = "group-1",
): PromotionCommand => ({
  _tag: "Flush",
  observedHead,
  groupId,
  committerTime: T0,
  barriers: BARRIERS,
  inputs,
});
const NEW = sha(0x1001);
const composedAs = (members: readonly ChangeId[], at: CommitSha = NEW): PromotionCommand => ({
  _tag: "Composed",
  sha: at,
  commits: commitsFor(members),
});
const composed = composedAs([C1]);
const readBack = (observed: CommitSha): PromotionCommand => ({ _tag: "ReadBack", observed });
const pushRefused = (
  reason: "pack-too-large" | "repo-bytes-quota",
  observed: CommitSha = H0,
): PromotionCommand => ({ _tag: "PushRefused", reason, observed });
const l1Path = [init, enqueue(1, C1), flush([facts(1, C1, "src/a.ts")]), composed];

/**
 * Each property plays hundreds of seeded runs through decide and evolve. Run
 * alone one takes about 1.5 s; inside the full unit suite on a busy runner it
 * has passed vitest's 5 s default, so it gets the arch tests' limit instead of
 * fewer runs (fewer runs would weaken every mutant's proof).
 */
const PROPERTY_TIMEOUT = 60_000;

describe("trunk promotion", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[promotion.transitions] in every phase a run reaches, every command lands where the docs' table says, or is refused", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const expected = oracle(r.before, p.command);
            if (expected === "refused") return Result.isFailure(p.result);
            if (expected === "noop")
              return Result.isSuccess(p.result) && p.result.success.length === 0;
            return (
              Result.isSuccess(p.result) && !p.threw && (p.after?.phase ?? "none") === expected
            );
          }),
        ),
      ),
    );
    // L1: one batch of one change, FIFO: verified → debounce → WAL → composed → read back new → advanced.
    const l1 = drive([...l1Path, readBack(NEW)]);
    expect(l1.tags).toEqual([
      ["TrunkInitialized"],
      ["BatchVerified"],
      ["PromotionStarted"],
      ["PromotionComposed"],
      ["TrunkAdvanced"],
    ]);
    expect(l1.state).toMatchObject({ phase: "idle", head: NEW, promoted: [C1] });
  });

  it("[promotion.replay] at every step, the received and committed events, through the wire, replay to the same trunk", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) => comparable(replayPromotion(throughTheWire(r.log))) === comparable(r.after),
        ),
      ),
    );
    expect(
      comparable(
        replayPromotion(
          throughTheWire(
            drive(l1Path).results.flatMap((d) =>
              eventsOf(d).map((payload) => ({ at: T0, payload })),
            ),
          ),
        ),
      ),
    ).toBe(comparable(drive(l1Path).state));
  });

  it("[promotion.decide-evolvable] evolve takes every event decide emits", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => !r.taken.threw && r.probes.every((p) => !p.threw)),
      ),
    );
    expect(() =>
      evolvePromotion(undefined, {
        at: T0,
        payload: { _tag: "PromotionResumed", projectId: PROJECT, by: "op" },
      }),
    ).toThrow(IllegalTransition);
  });

  it("[promotion.retry-same-wal] a read-back still on the old head commits nothing and leaves the WAL entry as it was", () => {
    let retries = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes
            .filter(
              (p) =>
                p.command._tag === "ReadBack" &&
                r.before?.wal?.composed !== undefined &&
                r.before.phase === "promoting" &&
                p.command.observed === r.before.wal.old,
            )
            .every((p) => {
              retries++;
              return (
                Result.isSuccess(p.result) &&
                p.result.success.length === 0 &&
                comparable(p.after) === comparable(r.before)
              );
            }),
        ),
      ),
    );
    expect(retries).toBeGreaterThan(0);
    const retried = drive([...l1Path, readBack(H0), readBack(H0), readBack(NEW)]);
    expect(retried.tags.slice(-3)).toEqual([[], [], ["TrunkAdvanced"]]);
  });

  it("[promotion.retry-pushes-recorded] once composed, the group's SHA never changes: a recompose that differs freezes, and trunk advances only to the recorded SHA", () => {
    let recomposes = 0;
    assertReaching(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          const recorded = r.before?.phase === "promoting" ? r.before.wal?.composed : undefined;
          if (recorded === undefined) return true;
          return r.probes.every((p) => {
            const advanced = eventsOf(p.result).flatMap((e) =>
              e._tag === "TrunkAdvanced" ? [e.to] : [],
            );
            const keeps = p.after?.phase !== "promoting" || p.after.wal?.composed === recorded;
            if (p.command._tag !== "Composed" || p.command.sha === recorded)
              return keeps && advanced.every((to) => to === recorded);
            // A report naming another chain is refused before its SHA is looked at.
            if (r.before?.wal !== undefined && !matchesGroup(p.command.commits, r.before.wal))
              return Result.isFailure(p.result);
            recomposes++;
            return tagsOf(p.result).join() === "PromotionFrozen";
          });
        }),
      ),
    );
    expect(recomposes).toBeGreaterThan(0);
    expect(drive([...l1Path, composedAs([C1], sha(0x3000))]).tags.at(-1)).toEqual([
      "PromotionFrozen",
    ]);
  });

  it("[promotion.unexpected-head-freezes] a head that is neither the old nor the new one freezes promotion, at the flush or at read-back", () => {
    let strays = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const b = r.before;
            const atFlush =
              p.command._tag === "Flush" &&
              b?.phase === "debouncing" &&
              p.command.observedHead !== b.head;
            const atReadBack =
              p.command._tag === "ReadBack" &&
              b?.phase === "promoting" &&
              b.wal?.composed !== undefined &&
              p.command.observed !== b.wal.old &&
              p.command.observed !== b.wal.composed;
            if (!atFlush && !atReadBack) return true;
            strays++;
            return tagsOf(p.result).join() === "PromotionFrozen" && p.after?.phase === "frozen";
          }),
        ),
      ),
    );
    expect(strays).toBeGreaterThan(0);
    expect(drive([...l1Path, readBack(STRAY)]).state?.frozen).toEqual({
      expected: NEW,
      observed: STRAY,
      reason: "readback-mismatch",
    });
    expect(
      drive([init, enqueue(1, C1), flush([facts(1, C1, "src/a.ts")], STRAY)]).state?.phase,
    ).toBe("frozen");
  });

  it("[promotion.freeze-says-why] every freeze names its trigger: a moved head at the flush, a recompose that disagrees, a stray head at read-back", () => {
    const seen = new Set<string>();
    const why: Readonly<Record<string, string>> = {
      Flush: "head-moved",
      Composed: "recompose-mismatch",
      ReadBack: "readback-mismatch",
    };
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) =>
            eventsOf(p.result).every((e) => {
              if (e._tag !== "PromotionFrozen") return true;
              seen.add(p.command._tag);
              return (
                e.reason === why[p.command._tag] &&
                (p.after === undefined || p.after.frozen?.reason === e.reason)
              );
            }),
          ),
        ),
      ),
    );
    expect([...seen].toSorted()).toEqual(["Composed", "Flush", "ReadBack"]);
    const flushed = drive([init, enqueue(1, C1), flush([facts(1, C1, "src/a.ts")], STRAY)]);
    expect(flushed.state?.frozen?.reason).toBe("head-moved");
    expect(drive([...l1Path, composedAs([C1], sha(0x3000))]).state?.frozen?.reason).toBe(
      "recompose-mismatch",
    );
  });

  it("[promotion.frozen-holds] nothing promotes from Frozen until an operator resumes", () => {
    let frozen = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          if (r.before?.phase !== "frozen") return true;
          frozen++;
          return r.probes.every(
            (p) =>
              !["PromotionStarted", "PromotionComposed", "TrunkAdvanced"].some((t) =>
                tagsOf(p.result).includes(t),
              ),
          );
        }),
      ),
    );
    expect(frozen).toBeGreaterThan(0);
    const held = drive([
      ...l1Path,
      readBack(STRAY),
      enqueue(2, C2),
      flush([facts(2, C2, "src/b.ts")]),
      readBack(NEW),
    ]);
    expect(held.results.slice(-2).map(failureTag)).toEqual([
      "PromotionStateRefused",
      "PromotionStateRefused",
    ]);
    const resumed = drive([
      ...l1Path,
      readBack(STRAY),
      { _tag: "Resume", by: RELEASER, head: STRAY },
    ]);
    expect(resumed.tags.at(-1)).toEqual(["PromotionDeclined", "PromotionResumed"]);
    expect(resumed.state).toMatchObject({ phase: "idle", head: STRAY });
  });

  it("[promotion.commutation-gates] a batch joins a group exactly when the commutation rule lets it, and is declined exactly when it does not", () => {
    let flushes = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            if (
              p.command._tag !== "Flush" ||
              r.before?.phase !== "debouncing" ||
              p.command.observedHead !== r.before.head
            )
              return true;
            flushes++;
            const expected = expectedFlush(r.before, p.command);
            const events = eventsOf(p.result);
            const started = events.flatMap((e) => (e._tag === "PromotionStarted" ? e.batches : []));
            const declined = events.flatMap((e) =>
              e._tag === "PromotionDeclined" ? [e.batchId] : [],
            );
            return (
              started.join() === expected.group.join() &&
              declined.join() === expected.declined.join()
            );
          }),
        ),
      ),
    );
    expect(flushes).toBeGreaterThan(0);
    // Two batches touching one path cannot share a group commit: the second is declined.
    const clash = drive([
      init,
      enqueue(1, C1),
      enqueue(2, C2),
      flush([facts(1, C1, "src/a.ts"), facts(2, C2, "src/a.ts")]),
    ]);
    expect(clash.tags.at(-1)).toEqual(["PromotionDeclined", "PromotionStarted"]);
  });

  it("[promotion.fifo] a group is the front of the queue in arrival order, and nothing passes a batch that must wait", () => {
    let waits = 0;
    assertReaching(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const started = eventsOf(p.result).flatMap((e) =>
              e._tag === "PromotionStarted" ? [e.batches] : [],
            )[0];
            if (started === undefined || r.before === undefined) return true;
            const declined = new Set(
              eventsOf(p.result).flatMap((e) =>
                e._tag === "PromotionDeclined" ? [e.batchId] : [],
              ),
            );
            const remaining = r.before.queue
              .filter((b) => !declined.has(b.batchId))
              .map((b) => b.batchId);
            if (remaining.length > started.length) waits++;
            return remaining.slice(0, started.length).join() === started.join();
          }),
        ),
      ),
    );
    expect(waits).toBeGreaterThan(0);
    // The first batch was speculated on a change trunk does not hold: the second waits behind it.
    const blocked = drive([
      init,
      enqueue(1, C1, [makeId("chg", ulid(77))]),
      enqueue(2, C2),
      flush([facts(1, C1, "src/a.ts"), facts(2, C2, "src/b.ts")]),
    ]);
    expect(blocked.tags.at(-1)).toEqual([]);
    expect(blocked.state?.queue.map((b) => b.members[0])).toEqual([C1, C2]);
  });

  it("[promotion.group-resolves-once] every WAL group ends exactly once: advanced, frozen, or declined batch by batch after a refused push", () => {
    let groups = 0;
    fc.assert(
      fc.property(planArb, (steps) => {
        const played = run(steps);
        const log = played.at(-1)?.log ?? [];
        let open: string | undefined;
        let left = 0;
        for (const { payload: e } of log) {
          if (e._tag === "PromotionStarted") {
            groups++;
            if (open !== undefined) return false;
            open = e.groupId;
            left = e.batches.length;
          } else if (
            e._tag === "PromotionDeclined" &&
            (e.reason === "pack-too-large" || e.reason === "repo-bytes-quota")
          ) {
            if (open === undefined) return false;
            left -= 1;
            if (left === 0) open = undefined;
          } else if (e._tag === "TrunkAdvanced") {
            if (open !== e.groupId) return false;
            open = undefined;
          } else if (e._tag === "PromotionFrozen" && e.groupId === open) {
            open = undefined;
          }
        }
        return true;
      }),
    );
    expect(groups).toBeGreaterThan(0);
    const done = drive([...l1Path, readBack(NEW), readBack(NEW)]);
    expect(failureTag(done.results.at(-1))).toBe("PromotionStateRefused");
    const refused = drive([...l1Path, pushRefused("pack-too-large"), readBack(NEW)]);
    expect(failureTag(refused.results.at(-1))).toBe("PromotionStateRefused");
  });

  it("[promotion.push-refused-declines] a refused push declines every batch of the group for its reason, each with a way forward, and ends the group: trunk does not move and nothing freezes", () => {
    let refusals = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "PushRefused" || !Result.isSuccess(p.result)) return true;
            refusals++;
            const before = r.before;
            const wal = before?.wal;
            const { reason } = p.command;
            return (
              before !== undefined &&
              wal !== undefined &&
              !p.threw &&
              p.result.success.length === wal.batches.length &&
              p.result.success.every(
                (e, i) =>
                  e._tag === "PromotionDeclined" &&
                  e.batchId === wal.batches[i]?.batchId &&
                  e.reason === reason &&
                  (e.nextActions ?? []).length > 0,
              ) &&
              p.after !== undefined &&
              p.after.wal === undefined &&
              p.after.frozen === undefined &&
              p.after.phase === (before.queue.length === 0 ? "idle" : "debouncing") &&
              p.after.head === before.head &&
              JSON.stringify(p.after.promoted) === JSON.stringify(before.promoted) &&
              JSON.stringify(p.after.queue) === JSON.stringify(before.queue)
            );
          }),
        ),
      ),
    );
    expect(refusals).toBeGreaterThan(0);
    for (const reason of ["pack-too-large", "repo-bytes-quota"] as const) {
      const refused = drive([...l1Path, pushRefused(reason)]);
      expect(refused.tags.at(-1)).toEqual(["PromotionDeclined"]);
      expect(eventsOf(refused.results.at(-1) ?? Result.succeed([]))).toMatchObject([
        { batchId: makeId("bat", ulid(1)), reason },
      ]);
      expect(refused.state).toMatchObject({ phase: "idle", head: H0, promoted: [] });
      expect(refused.state).not.toHaveProperty("wal");
      expect(refused.state).not.toHaveProperty("frozen");
    }
  });

  it("[promotion.push-refused-fenced] a push counts as refused only once the group is composed and trunk is still on the old head; anything else is turned away and commits nothing", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "PushRefused") return true;
            const wal = r.before?.wal;
            const fenced =
              r.before?.phase === "promoting" &&
              wal?.composed !== undefined &&
              p.command.observed === wal.old;
            return (
              Result.isSuccess(p.result) === fenced &&
              !p.threw &&
              (fenced ||
                (p.after === r.before &&
                  failureTag(p.result) ===
                    (r.before === undefined ? "TrunkNotInitialized" : "PromotionStateRefused")))
            );
          }),
        ),
      ),
    );
    // Before the group is composed there is no pack to refuse.
    const started = [init, enqueue(1, C1), flush([facts(1, C1, "src/a.ts")])];
    expect(failureTag(drive([...started, pushRefused("pack-too-large")]).results.at(-1))).toBe(
      "PromotionStateRefused",
    );
    // The composed SHA on trunk means the push landed: that is a read-back, and trunk advances.
    const landed = drive([...l1Path, pushRefused("pack-too-large", NEW), readBack(NEW)]);
    expect(failureTag(landed.results.at(-2))).toBe("PromotionStateRefused");
    expect(landed.tags.at(-1)).toEqual(["TrunkAdvanced"]);
    // A stray head is not a refusal either, and a refusal never freezes.
    const stray = drive([...l1Path, pushRefused("repo-bytes-quota", STRAY)]);
    expect(failureTag(stray.results.at(-1))).toBe("PromotionStateRefused");
    expect(stray.state?.phase).toBe("promoting");
    expect(failureTag(drive([init, pushRefused("pack-too-large")]).results.at(-1))).toBe(
      "PromotionStateRefused",
    );
  });

  it("[promotion.push-refused-solo] a pack too large bounces only a batch refused alone; a group of several is verified again and promoted one batch at a time until a push lands; a full repo bounces every member", () => {
    fc.assert(
      fc.property(planArb, (steps) => {
        const played = run(steps);
        const eachRefusal = played.every((r) =>
          r.probes.every((p) => {
            if (p.command._tag !== "PushRefused" || !Result.isSuccess(p.result)) return true;
            const wal = r.before?.wal;
            if (wal === undefined) return false;
            const again = p.command.reason === "pack-too-large" && wal.batches.length > 1;
            return (
              p.result.success.every(
                (e, i) =>
                  e._tag === "PromotionDeclined" &&
                  JSON.stringify(e.reverify) ===
                    JSON.stringify(again ? wal.batches[i]?.members : []),
              ) && (p.after?.solo === true) === (again || r.before?.solo === true)
            );
          }),
        );
        let solo = false;
        const oneAtATime = (played.at(-1)?.log ?? []).every(({ payload: e }) => {
          if (e._tag === "PromotionDeclined" && e.reason === "pack-too-large")
            solo = solo || e.reverify.length > 0;
          if (e._tag === "TrunkAdvanced") solo = false;
          return e._tag !== "PromotionStarted" || !solo || e.batches.length === 1;
        });
        return eachRefusal && oneAtATime && (played.at(-1)?.after?.solo === true) === solo;
      }),
    );
    const [b1, b2, b3, b4, b5] = [1, 2, 3, 4, 5].map((n) => makeId("bat", ulid(n)));
    const declines = (r: Decision | undefined) =>
      eventsOf(r ?? Result.succeed([])).flatMap((e) =>
        e._tag === "PromotionDeclined" ? [[e.batchId, e.reverify]] : [],
      );
    // One batch refused alone made the pack too large itself: its members bounce, and grouping carries on.
    const alone = drive([...l1Path, pushRefused("pack-too-large")]);
    expect(declines(alone.results.at(-1))).toEqual([[b1, []]]);
    expect(alone.state).not.toHaveProperty("solo");
    // Two batches refused together: neither is blamed, both are verified again.
    const pair = [
      init,
      enqueue(1, C1),
      enqueue(2, C2),
      flush([facts(1, C1, "src/a.ts"), facts(2, C2, "src/b.ts")]),
      composedAs([C1, C2]),
    ];
    const together = drive([...pair, pushRefused("pack-too-large")]);
    expect(declines(together.results.at(-1))).toEqual([
      [b1, [C1]],
      [b2, [C2]],
    ]);
    expect(together.state).toMatchObject({ phase: "idle", solo: true, head: H0 });
    // A full repo is no batch's doing: every member bounces, and nothing is promoted alone for it.
    const full = drive([...pair, pushRefused("repo-bytes-quota")]);
    expect(declines(full.results.at(-1))).toEqual([
      [b1, []],
      [b2, []],
    ]);
    expect(full.state).not.toHaveProperty("solo");
    // Verified again, the two would commute into one group; the next group is the first of them only.
    const second = [
      ...pair,
      pushRefused("pack-too-large"),
      enqueue(3, C1),
      enqueue(4, C2),
      flush([facts(3, C1, "src/a.ts"), facts(4, C2, "src/b.ts")], H0, "group-2"),
    ];
    const one = drive(second);
    expect(eventsOf(one.results.at(-1) ?? Result.succeed([]))).toMatchObject([
      { _tag: "PromotionStarted", batches: [b3] },
    ]);
    expect(one.state?.queue.map((b) => b.batchId)).toEqual([b4]);
    // Refused again, now alone: it bounces, and the trunk still promotes one batch at a time.
    const twice = drive([...second, composedAs([C1]), pushRefused("pack-too-large")]);
    expect(declines(twice.results.at(-1))).toEqual([[b3, []]]);
    expect(twice.state?.solo).toBe(true);
    // Once a push lands, grouping resumes: the next flush takes two batches again.
    const C3 = makeId("chg", ulid(3));
    const resumed = drive([
      ...second,
      composedAs([C1]),
      readBack(NEW),
      enqueue(5, C3),
      flush([facts(4, C2, "src/b.ts"), facts(5, C3, "src/c.ts")], NEW, "group-3"),
    ]);
    expect(resumed.results.map(tagsOf).at(-3)).toEqual(["TrunkAdvanced"]);
    expect(eventsOf(resumed.results.at(-1) ?? Result.succeed([]))).toMatchObject([
      { _tag: "PromotionStarted", batches: [b4, b5] },
    ]);
    expect(resumed.state).not.toHaveProperty("solo");
  });

  it("[promotion.landings] an advance lands every member of its group once, in order, each with its own batch's candidate and proof and its commit on trunk", () => {
    let advances = 0;
    let doubles = 0;
    assertReaching(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          [r.taken, ...r.probes].every((p) => {
            const wal = r.before?.wal;
            return eventsOf(p.result).every((e) => {
              if (e._tag !== "TrunkAdvanced") return true;
              if (wal === undefined) return false;
              advances++;
              if (wal.batches.some((b) => b.members.length > 1)) doubles++;
              const expected = wal.batches.flatMap((b, i) =>
                b.members.map((changeId) => ({
                  changeId,
                  commitSha: memberSha(changeId),
                  candidateId: b.candidateId,
                  proofId: wal.proofIds[i],
                })),
              );
              return canonicalJson(asJson(e.landings)) === canonicalJson(asJson(expected));
            });
          }),
        ),
      ),
    );
    expect(advances).toBeGreaterThan(0);
    expect(doubles).toBeGreaterThan(0);
    // A batch of two, then a batch of one, promoted in one group: each member lands with its own batch's proof.
    const C3 = makeId("chg", ulid(3));
    const pair: PromotionCommand = {
      _tag: "Enqueue",
      batchId: makeId("bat", ulid(1)),
      candidateId: makeId("cnd", ulid(1)),
      verdictId: makeId("vrd", ulid(1)),
      members: [C1, C2],
      base: H0,
      predecessors: [],
    };
    const group = drive([
      init,
      pair,
      enqueue(2, C3),
      flush([
        { ...facts(1, C1, "src/a.ts"), touched: footprints([C1, C2], ["src/a.ts"]) },
        facts(2, C3, "src/c.ts"),
      ]),
      composedAs([C1, C2, C3]),
      readBack(NEW),
    ]);
    const started = eventsOf(group.results[3] ?? Result.succeed([])).find(
      (e) => e._tag === "PromotionStarted",
    );
    const advanced = eventsOf(group.results.at(-1) ?? Result.succeed([])).find(
      (e) => e._tag === "TrunkAdvanced",
    );
    const proofs = started?._tag === "PromotionStarted" ? started.proofIds : [];
    expect(proofs).toHaveLength(2);
    expect(advanced?._tag === "TrunkAdvanced" ? advanced.landings : []).toEqual([
      {
        changeId: C1,
        commitSha: memberSha(C1),
        candidateId: makeId("cnd", ulid(1)),
        proofId: proofs[0],
      },
      {
        changeId: C2,
        commitSha: memberSha(C2),
        candidateId: makeId("cnd", ulid(1)),
        proofId: proofs[0],
      },
      {
        changeId: C3,
        commitSha: memberSha(C3),
        candidateId: makeId("cnd", ulid(2)),
        proofId: proofs[1],
      },
    ]);
  });

  it("[promotion.composed-matches-group] a composer's report naming any chain but the group's members, in order, is refused and records nothing", () => {
    let mismatches = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) =>
          r.probes.every((p) => {
            const wal = r.before?.wal;
            if (
              p.command._tag !== "Composed" ||
              r.before?.phase !== "promoting" ||
              wal === undefined
            )
              return true;
            if (matchesGroup(p.command.commits, wal)) return Result.isSuccess(p.result);
            mismatches++;
            return (
              failureTag(p.result) === "CompositionMismatch" &&
              comparable(p.after) === comparable(r.before)
            );
          }),
        ),
      ),
    );
    expect(mismatches).toBeGreaterThan(0);
    const wrong = drive([...l1Path.slice(0, -1), composedAs([C2])]);
    expect(failureTag(wrong.results.at(-1))).toBe("CompositionMismatch");
    expect(wrong.state?.wal?.composed).toBeUndefined();
  });

  it("[promotion.initialized-first] nothing is queued or promoted before the trunk's first head is known", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) =>
            r.before !== undefined ||
            r.probes.every((p) =>
              p.command._tag === "Initialize"
                ? Result.isSuccess(p.result)
                : failureTag(p.result) === "TrunkNotInitialized",
            ),
        ),
      ),
    );
    const early = drive([flush([], STRAY), init]);
    expect(failureTag(early.results[0])).toBe("TrunkNotInitialized");
    expect(early.state?.head).toBe(H0);
  });
});

// The chart checks the machine; it never drives it.

const promotionMachine: Machine<
  Trunk,
  PromotionCommand,
  TrunkEvent,
  { readonly now: Instant; readonly projectId: typeof PROJECT }
> = { decide: decidePromotion, evolve: evolvePromotion };

const phaseOf = (t: Trunk | undefined): Phase => t?.phase ?? "none";
const promotionView: View<Trunk, TrunkEvent> = {
  from: (f) => phaseOf(f.before),
  to: (f) => phaseOf(f.after),
};

/** The machine walked breadth-first: every command kind, honest and stray, on a fresh path or a barrier, current or behind. */
let walkedTour: readonly Fold<Trunk, TrunkEvent>[] | undefined;
const promotionTour = (): readonly Fold<Trunk, TrunkEvent>[] => {
  if (walkedTour !== undefined) return walkedTour;
  const world: World = { touched: new Map(), behind: new Set(), n: 100 };
  walkedTour = tour(promotionMachine, {
    start: T0,
    facts: (now) => ({ now, projectId: PROJECT }),
    moves: (state) =>
      KINDS.flatMap((kind) =>
        [true, false].flatMap((honest) =>
          [false, true].flatMap((behind) =>
            [0, 1].map((pick) => ({
              command: build(
                kind,
                state,
                { mode: "progress", pick, honest, path: pick, behind },
                world,
              ),
              dt: 1,
            })),
          ),
        ),
      ),
    signature: (t) =>
      [
        phaseOf(t),
        // The first two queued batches, each by what the flush will make of it: behind, waiting, or neither,
        // and the path it touched, since two batches join one group only on different paths.
        (t?.queue ?? [])
          .slice(0, 2)
          .map(
            (b) =>
              `${world.behind.has(b.batchId) ? "b" : ""}${b.predecessors.length > 0 ? "w" : ""}${world.touched.get(b.batchId) ?? ""}.`,
          )
          .join(""),
        t?.wal === undefined ? "-" : t.wal.composed === undefined ? "started" : "composed",
        // A group of one batch or of several: a refused push treats them differently.
        Math.min(t?.wal?.batches.length ?? 0, 2),
        t?.solo === true ? "solo" : "-",
        t?.frozen === undefined ? "-" : "frozen",
      ].join("|"),
  });
  return walkedTour;
};

/** A verdict's `verified` flag as the Lane DO sets it. */
type Flag = "absent" | boolean;
const withFlag = (flag: Flag): { readonly verified?: boolean } =>
  flag === "absent" ? {} : { verified: flag };
const flagIn = (x: { readonly verified?: boolean | undefined }): Flag => x.verified ?? "absent";
const PLAN = ContentHash.make(`sha256:${"0".repeat(64)}`);

/** One batch through the Lane DO's Candidate machine, from its verdict to `BatchVerified`. */
const verifyBatch = (n: number, flag: Flag) => {
  const batchId = makeId("bat", ulid(n));
  const commands: readonly CandidateCommand[] = [
    {
      _tag: "Form",
      laneId: "lane:default",
      projectId: PROJECT,
      members: [makeId("chg", ulid(n))],
      base: H0,
      predecessors: [],
      attempt: 1,
      chainEpoch: 0,
    },
    {
      _tag: "Assemble",
      candidateId: makeId("cnd", ulid(n)),
      treeSha: sha(0xb000 + n),
      composer: "gitcore",
      tier: 0,
      tierReason: "clean merge-tree",
    },
    { _tag: "StartVerification", instanceId: `verify-${n}`, planHash: PLAN },
    {
      _tag: "Verified",
      verdictId: makeId("vrd", ulid(n)),
      ...withFlag(flag),
      attempt: 1,
      chainEpoch: 0,
    },
  ];
  let batch: Batch | undefined;
  let last: readonly CandidateEvent[] = [];
  for (const command of commands) {
    const decided = decideCandidate(batch, command, { now: T0, batchId });
    if (Result.isFailure(decided)) return undefined;
    for (const payload of decided.success) batch = evolveCandidate(batch, { at: T0, payload });
    last = decided.success;
  }
  const event = last[0];
  return event?._tag === "BatchVerified" ? event : undefined;
};

/** Verdicts with these flags, verified by the lane, then queued, grouped and advanced by the trunk. */
const carry = (flags: readonly Flag[]) => {
  const verified = flags.map((flag, i) => verifyBatch(i + 1, flag));
  const enqueues = verified.flatMap((e): PromotionCommand[] =>
    e?.members === undefined || e.base === undefined
      ? []
      : [
          {
            _tag: "Enqueue",
            batchId: e.batchId,
            candidateId: e.candidateId,
            verdictId: e.verdictId,
            members: e.members,
            base: e.base,
            predecessors: e.predecessors ?? [],
            ...(e.verified === undefined ? {} : { verified: e.verified }),
          },
        ],
  );
  // Each batch on a path of its own, so the whole queue commutes into one group.
  const inputs = enqueues.map((_, i) =>
    facts(i + 1, makeId("chg", ulid(i + 1)), `src/own-${i}.ts`),
  );
  const queued = drive([init, ...enqueues]).state;
  const grouped = drive([init, ...enqueues, flush(inputs)]).state;
  const done = drive([
    init,
    ...enqueues,
    flush(inputs),
    composedAs(enqueues.flatMap((e) => (e._tag === "Enqueue" ? e.members : []))),
    readBack(NEW),
  ]);
  const advanced = eventsOf(done.results.at(-1) ?? Result.succeed([])).find(
    (e) => e._tag === "TrunkAdvanced",
  );
  return { verified, queued, grouped, advanced };
};

const carries = (flags: readonly Flag[]): boolean => {
  const { verified, queued, grouped, advanced } = carry(flags);
  const same = (got: readonly (Flag | undefined)[]): boolean =>
    got.length === flags.length && got.every((f, i) => f === flags[i]);
  return (
    same(verified.map((e) => (e === undefined ? undefined : flagIn(e)))) &&
    same((queued?.queue ?? []).map(flagIn)) &&
    same((grouped?.wal?.batches ?? []).map(flagIn)) &&
    advanced !== undefined &&
    flagIn(advanced) === (flags.includes(false) ? false : "absent")
  );
};

describe("trunk height", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[promotion.height] each advance is one higher than the last, from 0 at TrunkInitialized, and a resume keeps the height", () => {
    let advances = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          const heights = r.log.flatMap((c) =>
            c.payload._tag === "TrunkAdvanced" ? [c.payload.height] : [],
          );
          advances += heights.length;
          // Whatever decide proposes is one above the trunk it decided from, committed or not.
          const proposed = [r.taken, ...r.probes].flatMap((p) =>
            eventsOf(p.result).flatMap((e) => (e._tag === "TrunkAdvanced" ? [e.height] : [])),
          );
          const next = (r.before?.height ?? 0) + 1;
          return (
            heights.every((h, i) => h === i + 1) &&
            proposed.every((h) => h === next) &&
            (r.after === undefined || r.after.height === heights.length)
          );
        }),
      ),
    );
    expect(advances).toBeGreaterThan(0);
    const twice = drive([
      ...l1Path,
      readBack(NEW),
      enqueue(2, C2),
      flush([facts(2, C2, "src/b.ts")], NEW, "group-2"),
      composedAs([C2], sha(0x1002)),
      readBack(sha(0x1002)),
    ]);
    const advanced = twice.results.flatMap((r) =>
      eventsOf(r).flatMap((e) => (e._tag === "TrunkAdvanced" ? [e.height] : [])),
    );
    expect(advanced).toEqual([1, 2]);
    expect(twice.state?.height).toBe(2);
  });
});

describe("the verified flag", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[promotion.verified-carried] a verdict's verified flag reaches BatchVerified, the queue and the WAL unchanged, and one unverified batch makes the advance unverified", () => {
    const flagArb = fc.constantFrom<Flag>("absent", true, false);
    fc.assert(
      fc.property(fc.array(flagArb, { minLength: 1, maxLength: 4 }), (flags) => carries(flags)),
    );
    // A mixed group: one unverified batch in a group of verified ones.
    const mixed = carry([true, false, "absent"]);
    expect(mixed.verified.map((e) => e?.verified)).toEqual([true, false, undefined]);
    expect(mixed.advanced).toMatchObject({ _tag: "TrunkAdvanced", verified: false });
    expect(carry(["absent", true]).advanced).not.toHaveProperty("verified");
  });
});

/** A batch as the table knows it: its id and its members, in order. */
interface Slot {
  readonly batchId: BatchId;
  readonly members: readonly ChangeId[];
}

/** What the fold's table is about: the phase, the head and its height, who waits, and the group being pushed. */
interface FoldedTrunk {
  readonly phase: Trunk["phase"];
  readonly head: CommitSha;
  readonly height?: number;
  readonly queue: readonly Slot[];
  readonly group?: {
    readonly id: string;
    readonly old: CommitSha;
    readonly batches: readonly Slot[];
    readonly composed?: CommitSha;
  };
  readonly solo: boolean;
  readonly frozen: boolean;
  readonly promoted: number;
}

const slotOf = (b: Slot): Slot => ({ batchId: b.batchId, members: b.members });
const holds = (slots: readonly Slot[], batchId: BatchId): boolean =>
  slots.some((s) => s.batchId === batchId);
const less = (slots: readonly Slot[], batchId: BatchId): readonly Slot[] =>
  slots.filter((s) => s.batchId !== batchId);
/** The phase a trunk rests in once nothing is being pushed. */
const rests = (queue: readonly Slot[]): Trunk["phase"] =>
  queue.length === 0 ? "idle" : "debouncing";

/** The fold's from-table (state-machines.md § Promotion), typed apart from `evolvePromotion`. */
const trunkFolds = (from: FoldedTrunk | undefined, event: TrunkEvent): FoldedTrunk | "illegal" => {
  if (from === undefined)
    return event._tag === "TrunkInitialized"
      ? {
          phase: "idle",
          head: event.head,
          height: 0,
          queue: [],
          solo: false,
          frozen: false,
          promoted: 0,
        }
      : "illegal";
  const { group } = from;
  switch (event._tag) {
    case "TrunkInitialized":
      return "illegal";
    case "BatchVerified":
      if (event.members === undefined || event.base === undefined) return "illegal";
      if (holds(from.queue, event.batchId)) return "illegal";
      return {
        ...from,
        queue: [...from.queue, { batchId: event.batchId, members: event.members }],
        phase: from.phase === "idle" ? "debouncing" : from.phase,
      };
    case "PromotionDeclined": {
      if (event.reason === "frozen")
        return from.phase === "frozen" && group !== undefined && holds(group.batches, event.batchId)
          ? { ...from, group: { ...group, batches: less(group.batches, event.batchId) } }
          : "illegal";
      if (event.reason === "commutation-failed") {
        if (from.phase !== "debouncing" || !holds(from.queue, event.batchId)) return "illegal";
        const queue = less(from.queue, event.batchId);
        return { ...from, queue, phase: rests(queue) };
      }
      // The push was refused: only a composed group has pushed anything.
      if (from.phase !== "promoting" || group?.composed === undefined) return "illegal";
      if (!holds(group.batches, event.batchId)) return "illegal";
      const batches = less(group.batches, event.batchId);
      const { group: _ended, ...ended } = from;
      const left: FoldedTrunk =
        batches.length > 0
          ? { ...from, group: { ...group, batches } }
          : { ...ended, phase: rests(from.queue) };
      return event.reason === "pack-too-large" && event.reverify.length > 0
        ? { ...left, solo: true }
        : left;
    }
    case "PromotionStarted": {
      const front = from.queue.slice(0, event.batches.length);
      const fifo =
        event.batches.length > 0 && front.map((s) => s.batchId).join() === event.batches.join();
      return from.phase === "debouncing" && event.old === from.head && fifo
        ? {
            ...from,
            phase: "promoting",
            queue: from.queue.slice(front.length),
            group: { id: event.groupId, old: event.old, batches: front },
          }
        : "illegal";
    }
    case "PromotionComposed":
      return from.phase === "promoting" &&
        group !== undefined &&
        group.id === event.groupId &&
        group.composed === undefined &&
        event.commits.map((c) => c.changeId).join() ===
          group.batches.flatMap((s) => s.members).join()
        ? { ...from, group: { ...group, composed: event.sha } }
        : "illegal";
    case "TrunkAdvanced": {
      const lands =
        from.phase === "promoting" &&
        group !== undefined &&
        group.id === event.groupId &&
        group.old === event.from &&
        group.composed === event.to &&
        event.landings.map((l) => l.changeId).join() ===
          group.batches.flatMap((s) => s.members).join();
      const next =
        event.height === undefined || from.height === undefined || event.height === from.height + 1;
      if (!lands || !next) return "illegal";
      const { group: _landed, height: _before, ...landed } = from;
      return {
        ...landed,
        solo: false,
        head: event.to,
        promoted: from.promoted + event.landings.length,
        phase: rests(from.queue),
        ...(event.height === undefined ? {} : { height: event.height }),
      };
    }
    case "PromotionFrozen":
      return (from.phase === "debouncing" && event.expected === from.head) ||
        (from.phase === "promoting" && group !== undefined && group.id === event.groupId)
        ? { ...from, phase: "frozen", frozen: true }
        : "illegal";
    case "PromotionResumed": {
      if (from.phase !== "frozen" || (group !== undefined && group.batches.length > 0))
        return "illegal";
      const { group: _dropped, ...resumed } = from;
      return { ...resumed, frozen: false, head: event.head ?? from.head, phase: rests(from.queue) };
    }
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

const DECLINES = ["commutation-failed", "frozen", "pack-too-large", "repo-bytes-quota"] as const;
/** A batch no trunk of the tour ever holds. */
const STRAY_BATCH = makeId("bat", ulid(999_999));

/** An event in every form the trunk's fold could tell apart. */
const trunkForms = (event: TrunkEvent): readonly TrunkEvent[] => {
  switch (event._tag) {
    case "BatchVerified":
      return [event, { ...event, members: undefined }, { ...event, base: undefined }];
    case "PromotionDeclined":
      return DECLINES.flatMap((reason) => [
        { ...event, reason, reverify: [] },
        { ...event, reason, reverify: [makeId("chg", ulid(1))] },
        { ...event, reason, reverify: [], batchId: STRAY_BATCH },
      ]);
    case "PromotionStarted":
      return [
        event,
        { ...event, old: STRAY },
        { ...event, batches: [] },
        { ...event, batches: event.batches.toReversed() },
        { ...event, batches: event.batches.slice(1) },
        { ...event, batches: [...event.batches, STRAY_BATCH] },
      ];
    case "PromotionComposed":
      return [
        event,
        { ...event, groupId: "another-group" },
        { ...event, commits: event.commits.slice(1) },
        { ...event, commits: event.commits.toReversed() },
      ];
    case "TrunkAdvanced":
      return [
        event,
        { ...event, groupId: "another-group" },
        { ...event, from: STRAY },
        { ...event, to: STRAY },
        { ...event, landings: event.landings.slice(1) },
        { ...event, height: undefined },
        { ...event, height: (event.height ?? 1) + 1 },
      ];
    case "PromotionFrozen":
      return [event, { ...event, expected: STRAY }, { ...event, groupId: "another-group" }];
    case "PromotionResumed":
      return [event, { ...event, head: undefined }, { ...event, head: STRAY }];
    default:
      return [event];
  }
};

/** What an event names of a trunk: batches, a group, and, for a freeze, the head it expected. */
const namedBy = (
  event: TrunkEvent,
): { readonly batches: readonly BatchId[]; readonly group?: string; readonly head?: CommitSha } => {
  switch (event._tag) {
    case "BatchVerified":
    case "PromotionDeclined":
      return { batches: [event.batchId] };
    case "PromotionStarted":
      return { batches: event.batches, group: event.groupId };
    case "PromotionComposed":
      return { batches: [], group: event.groupId };
    case "TrunkAdvanced":
      return { batches: [], group: event.groupId };
    case "PromotionFrozen":
      return { batches: [], group: event.groupId, head: event.expected };
    default:
      return { batches: [] };
  }
};

/** What an event names of this trunk: its group, a batch it holds or its head; or that it names nothing at all. */
const concerns = (trunk: Trunk, event: TrunkEvent): string | false => {
  const named = namedBy(event);
  if (named.batches.length === 0 && named.group === undefined) return "nothing named";
  if (named.group !== undefined && named.group === trunk.wal?.groupId) return "its group";
  const held = [...trunk.queue, ...(trunk.wal?.batches ?? [])].map((b) => b.batchId);
  if (named.batches.some((id) => held.includes(id))) return "its batch";
  return named.head === trunk.head ? "its head" : false;
};

/**
 * One state stands for each shape a trunk takes: its phase, how many wait, how far the group
 * got and how many batches it holds, and whether it is solo and frozen.
 */
const shapeOf = (t: Trunk | undefined): string =>
  t === undefined
    ? "none"
    : [
        t.phase,
        Math.min(t.queue.length, 2),
        t.wal === undefined ? "-" : t.wal.composed === undefined ? "started" : "composed",
        Math.min(t.wal?.batches.length ?? 0, 2),
        t.solo === true,
        t.frozen !== undefined,
      ].join("|");

/**
 * One fold past the tour. The fold freezes a group whether or not it was composed, and the
 * machine freezes only a composed one, so no run reaches a trunk frozen on a group it never
 * composed. The fold does, in one event, and what it must refuse from there is its table's too.
 */
const frozenUncomposed = (
  walked: readonly Fold<Trunk, TrunkEvent>[],
): readonly Fold<Trunk, TrunkEvent>[] => {
  const started = new Map<string, Trunk>();
  for (const { after } of walked)
    if (after.phase === "promoting" && after.wal?.composed === undefined)
      started.set(shapeOf(after), started.get(shapeOf(after)) ?? after);
  return [...started.values()].map((before) => {
    const event = PromotionFrozen.make({
      projectId: PROJECT,
      groupId: before.wal?.groupId ?? "",
      expected: before.head,
      observed: STRAY,
      reason: "readback-mismatch",
    });
    return { before, event, after: evolvePromotion(before, { at: T0, payload: event }) };
  });
};

describe("the Promotion fold", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[promotion.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const toured = promotionTour();
    const walked = [...toured, ...frozenUncomposed(toured)];
    const kinds = new Map<string, TrunkEvent>();
    for (const { event } of walked) if (!kinds.has(event._tag)) kinds.set(event._tag, event);
    const firsts = new Set(kinds.values());
    const cases = foldCases<Trunk, TrunkEvent, FoldedTrunk>({
      evolve: evolvePromotion,
      walked,
      summary: (t) => ({
        phase: t.phase,
        head: t.head,
        ...(t.height === undefined ? {} : { height: t.height }),
        queue: t.queue.map(slotOf),
        ...(t.wal === undefined
          ? {}
          : {
              group: {
                id: t.wal.groupId,
                old: t.wal.old,
                batches: t.wal.batches.map(slotOf),
                ...(t.wal.composed === undefined ? {} : { composed: t.wal.composed }),
              },
            }),
        solo: t.solo === true,
        frozen: t.frozen !== undefined,
        promoted: t.promoted.length,
      }),
      shown: (f) => canonicalJson(asJson(f)),
      row: shapeOf,
      // Every row meets the first event of each kind the tour committed, and every event
      // that names its group, a batch it holds or its head: at most eight of a kind for each
      // of those, so the thousands of freezes that expect its head leave its own group's in.
      meets: (t, event) =>
        (t !== undefined && concerns(t, event)) || (firsts.has(event) && "the first of its kind"),
      most: 8,
      forms: trunkForms,
      times: [T0],
      table: trunkFolds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Fifty-three shapes of trunk, nine of them one fold past the tour, each meeting at most
    // eight events of a kind for each reason, in every form.
    const shape = foldShape(cases);
    expect({ ...shape, rows: shape.rows.length }).toEqual({
      folds: 10064,
      refused: 9126,
      rows: 53,
    });
  });
});

describe("the Promotion chart", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[promotion.chart] every phase change a run makes is an edge of the Promotion chart, and a tour of the machine exercises every edge", () => {
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every(
          (r) =>
            offChart(
              promotionChart,
              foldsOf(
                promotionMachine,
                r.before,
                [r.taken.result, ...r.probes.map((p) => p.result)],
                r.now,
              ),
              promotionView,
            ).length === 0,
        ),
      ),
    );
    const walked = promotionTour();
    expect(offChart(promotionChart, walked, promotionView)).toEqual([]);
    expect(uncovered(promotionChart, walked, promotionView)).toEqual([]);
  });
});
