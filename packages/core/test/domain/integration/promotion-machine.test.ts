import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Batch,
  BatchDropped,
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
  syncGroupId,
  Trunk,
  TrunkEvent,
  type TrunkOrigin,
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
  syncing: ["ReadBack", "Enqueue"],
};
/**
 * What each step tries besides the kinds it draws from: a sync from upstream, and a cancel.
 * Neither is drawn, so no plan's walk moves. The tours' trunk was not imported, so each sync
 * is refused, and the sync's own walk is `syncTour`'s; a cancel's is `cancelTour`'s.
 */
const PROBED: readonly Kind[] = [...KINDS, "Sync", "Cancel"];

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
  // A sync or a cancel counts nothing in the world, so trying one moves no batch's id, shape or flag.
  if (kind === "Sync") return syncCommand(state, step);
  if (kind === "Cancel") return cancelCommand(state, step);
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
      // An open sync is read back at its start, its target, or a stray head.
      const sync = state?.phase === "syncing" ? state.sync : undefined;
      if (sync !== undefined)
        return {
          _tag: "ReadBack",
          observed: !step.honest ? STRAY : step.pick % 3 === 0 ? sync.from : sync.to,
        };
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

/** Upstream's head a sync moves to: one of two, so a walk meets a sync again after one landed. */
const UPSTREAM = [sha(0x3001), sha(0x3002)] as const;
/** A sync from the head trunk holds, mostly; now and then from a stray one, or to the head itself. */
function syncCommand(state: Trunk | undefined, step: Step): PromotionCommand {
  const head = state?.head ?? H0;
  const to = step.pick % 4 === 3 ? head : (UPSTREAM[step.pick % 2] ?? H0);
  return { _tag: "Sync", by: RELEASER, from: step.honest ? head : STRAY, to };
}

/** Ids no step mints: the world counts from 100 and no walk reaches nine million. */
const OUTSIDE = 9_000_000;
/** The failed batch a cancel names. */
const RED = makeId("bat", ulid(OUTSIDE));
/**
 * A cancel of a queued batch, of one in the group being pushed, of one whose member landed, of
 * a dropped one again, or of one whose verdict has not arrived: whichever `pick` names.
 */
function cancelCommand(state: Trunk | undefined, step: Step): PromotionCommand {
  const unseen = {
    batchId: makeId("bat", ulid(OUTSIDE + 1 + (step.pick % 2))),
    members: [makeId("chg", ulid(OUTSIDE + 1))],
  };
  const targets: readonly { readonly batchId: BatchId; readonly members: readonly ChangeId[] }[] = [
    ...(state?.queue ?? []),
    ...(state?.wal?.batches ?? []),
    ...(state?.promoted ?? [])
      .slice(-1)
      .map((member) => ({ batchId: makeId("bat", ulid(OUTSIDE + 3)), members: [member] })),
    ...(state?.dropped ?? []).slice(-1).map((batchId) => ({ batchId, members: unseen.members })),
    unseen,
  ];
  const target = targets[step.pick % targets.length] ?? unseen;
  return { _tag: "Cancel", batchId: target.batchId, because: RED, members: target.members };
}

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
    const probes = PROBED.map((k) => attempt(before, build(k, before, step, world), now));
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
      return [...before.queue, ...(wal?.batches ?? [])].some(
        (b) => b.batchId === command.batchId,
      ) || before.dropped?.includes(command.batchId) === true
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
      if (before.phase === "syncing" && before.sync !== undefined) {
        if (command.observed === before.sync.from) return "noop";
        return command.observed === before.sync.to ? settled(before, 0) : "frozen";
      }
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
    case "Sync":
      // Only an import has an upstream, and a sync starts between groups, from trunk's own head.
      if (before.origin?.kind !== "imported") return "refused";
      if (before.phase !== "idle" && before.phase !== "debouncing") return "refused";
      if (command.from !== before.head) return "refused";
      return command.to === command.from ? "noop" : "syncing";
    case "Cancel":
      // A dropped batch is answered the same again. Too late once it is being pushed or landed.
      if (before.dropped?.includes(command.batchId) === true) return "noop";
      if (wal?.batches.some((b) => b.batchId === command.batchId) === true) return "refused";
      if (command.members.some((m) => before.promoted.includes(m))) return "refused";
      return before.phase === "debouncing" &&
        before.queue.some((b) => b.batchId === command.batchId)
        ? settled(before, 1)
        : before.phase;
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
    // One batch of one change, FIFO: verified → debounce → WAL → composed → read back new → advanced.
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

/** An import's origin: the upstream a sync reads, and trunk's first head. */
const IMPORTED: TrunkOrigin = {
  kind: "imported",
  url: "https://git.example/upstream.git",
  ref: "refs/heads/main",
  commit: H0,
};
const importedInit: PromotionCommand = {
  _tag: "Initialize",
  head: H0,
  by: "seed",
  origin: IMPORTED,
};

/**
 * The machine walked breadth-first from an imported trunk, with a sync from upstream among its
 * moves: every edge of a sync, with batches queued around it and a freeze after it. Its own
 * walk, so the promotion tour and its fold table stay as they were.
 */
let walkedSyncTour: readonly Fold<Trunk, TrunkEvent>[] | undefined;
const syncTour = (): readonly Fold<Trunk, TrunkEvent>[] => {
  if (walkedSyncTour !== undefined) return walkedSyncTour;
  const world: World = { touched: new Map(), behind: new Set(), n: 100 };
  walkedSyncTour = tour(promotionMachine, {
    start: T0,
    facts: (now) => ({ now, projectId: PROJECT }),
    moves: (state) =>
      state === undefined
        ? [{ command: importedInit, dt: 1 }]
        : PROBED.filter((kind) => kind !== "Initialize" && kind !== "Cancel").flatMap((kind) =>
            [true, false].flatMap((honest) =>
              [0, 1, 2, 3].map((pick) => ({
                command: build(
                  kind,
                  state,
                  { mode: "progress", pick, honest, path: pick % PATHS.length, behind: false },
                  world,
                ),
                dt: 1,
              })),
            ),
          ),
    signature: (t) =>
      [
        phaseOf(t),
        Math.min(t?.queue.length ?? 0, 2),
        t?.wal === undefined ? "-" : t.wal.composed === undefined ? "started" : "composed",
        t?.sync === undefined ? "-" : "sync",
        t?.frozen === undefined ? "-" : "frozen",
        // Whether trunk is at an upstream head: a second sync starts from one.
        t !== undefined && UPSTREAM.some((u) => u === t.head) ? "upstream" : "-",
      ].join("|"),
  });
  return walkedSyncTour;
};

/**
 * The machine walked breadth-first from an imported trunk with a cancel among its moves: every
 * batch cancelled from every phase, a sync's among them, queued, pushed, landed, dropped already,
 * or not seen yet, and the verdicts that come after. Its own walk, so the promotion tour and its
 * fold table stay as they were.
 */
let walkedCancelTour: readonly Fold<Trunk, TrunkEvent>[] | undefined;
const cancelTour = (): readonly Fold<Trunk, TrunkEvent>[] => {
  if (walkedCancelTour !== undefined) return walkedCancelTour;
  const world: World = { touched: new Map(), behind: new Set(), n: 100 };
  walkedCancelTour = tour(promotionMachine, {
    start: T0,
    facts: (now) => ({ now, projectId: PROJECT }),
    moves: (state) =>
      state === undefined
        ? [{ command: importedInit, dt: 1 }]
        : PROBED.filter((kind) => kind !== "Initialize").flatMap((kind) =>
            [true, false].flatMap((honest) =>
              [0, 1, 2, 3].map((pick) => ({
                command: build(
                  kind,
                  state,
                  { mode: "progress", pick, honest, path: pick % PATHS.length, behind: false },
                  world,
                ),
                dt: 1,
              })),
            ),
          ),
    signature: (t) =>
      [
        phaseOf(t),
        Math.min(t?.queue.length ?? 0, 2),
        t?.wal === undefined ? "-" : t.wal.composed === undefined ? "started" : "composed",
        t?.sync === undefined ? "-" : "sync",
        t?.frozen === undefined ? "-" : "frozen",
        Math.min(t?.dropped?.length ?? 0, 2),
        Math.min(t?.promoted.length ?? 0, 1),
      ].join("|"),
  });
  return walkedCancelTour;
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

/** The head an event names as trunk's from then on, if it names one. */
const headAfter = (event: TrunkEvent): CommitSha | undefined =>
  event._tag === "TrunkInitialized" || event._tag === "PromotionResumed"
    ? event.head
    : event._tag === "TrunkAdvanced"
      ? event.to
      : undefined;

/** When trunk's head last changed, read off a log: the time of the last event that named another head. */
const headChangedAt = (log: readonly Committed<TrunkEvent>[]): Instant | undefined => {
  let head: CommitSha | undefined;
  let at: Instant | undefined;
  for (const committed of log) {
    const next = headAfter(committed.payload);
    if (next !== undefined && next !== head) {
      head = next;
      at = committed.at;
    }
  }
  return at;
};

/** A scenario's events, each at an instant of its own, and trunk's advancedAt after each. */
const timedThrough = (commands: readonly PromotionCommand[]) => {
  const timed = drive(commands)
    .results.flatMap(eventsOf)
    .map((payload, i) => ({ at: Instant(T0 + i + 1), payload }));
  return {
    timed,
    tags: timed.map((c) => c.payload._tag),
    seen: timed.map((_, i) => replayPromotion(timed.slice(0, i + 1))?.advancedAt),
  };
};

describe("when trunk's head last changed", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[trunk.advanced-at] trunk's advancedAt is the commit time of the event that last changed its head: TrunkInitialized, each TrunkAdvanced, and a resume at another head; a batch queued, a decline, a freeze and a resume at the same head leave it", () => {
    let advances = 0;
    let resumes = 0;
    fc.assert(
      fc.property(planArb, (steps) =>
        run(steps).every((r) => {
          if (r.log.at(-1)?.payload._tag === "TrunkAdvanced") advances += 1;
          if (r.log.at(-1)?.payload._tag === "PromotionResumed") resumes += 1;
          return r.after?.advancedAt === headChangedAt(r.log);
        }),
      ),
    );
    expect(advances).toBeGreaterThan(0);
    expect(resumes).toBeGreaterThan(0);
    // By hand: one advance, then a second group frozen at read-back on a head that is not
    // Keel's, and the operator's resume at that head.
    const moved = timedThrough([
      ...l1Path,
      readBack(NEW),
      enqueue(2, C2),
      flush([facts(2, C2, "src/b.ts")], NEW, "group-2"),
      composedAs([C2], sha(0x1002)),
      readBack(STRAY),
      { _tag: "Resume", by: RELEASER, head: STRAY },
    ]);
    expect(moved.tags).toEqual([
      "TrunkInitialized",
      "BatchVerified",
      "PromotionStarted",
      "PromotionComposed",
      "TrunkAdvanced",
      "BatchVerified",
      "PromotionStarted",
      "PromotionComposed",
      "PromotionFrozen",
      "PromotionDeclined",
      "PromotionResumed",
    ]);
    expect(moved.seen).toEqual([
      ...Array.from({ length: 4 }, () => moved.timed[0]?.at),
      ...Array.from({ length: 6 }, () => moved.timed[4]?.at),
      moved.timed[10]?.at,
    ]);
    expect(replayPromotion(moved.timed)).toMatchObject({ head: STRAY });
    // A resume at the head trunk already has changes no head, and no time.
    const stayed = timedThrough([
      ...l1Path,
      readBack(STRAY),
      { _tag: "Resume", by: RELEASER, head: H0 },
    ]);
    expect(stayed.tags.at(-1)).toBe("PromotionResumed");
    expect(new Set(stayed.seen)).toEqual(new Set([stayed.timed[0]?.at]));
    expect(replayPromotion(stayed.timed)).toMatchObject({ head: H0, phase: "idle" });
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
    readonly proofIds: readonly string[];
    readonly committerTime: Instant;
    readonly composed?: CommitSha;
  };
  readonly solo: boolean;
  readonly frozen: boolean;
  readonly promoted: number;
  /** When its head last changed: the instant of the fold that changed it. */
  readonly advancedAt?: Instant;
  /** The open sync from upstream: where it moves main from and to. */
  readonly sync?: { readonly from: CommitSha; readonly to: CommitSha };
}

const slotOf = (b: Slot): Slot => ({ batchId: b.batchId, members: b.members });
const holds = (slots: readonly Slot[], batchId: BatchId): boolean =>
  slots.some((s) => s.batchId === batchId);
const less = (slots: readonly Slot[], batchId: BatchId): readonly Slot[] =>
  slots.filter((s) => s.batchId !== batchId);
/**
 * The instants the table folds each event at: before the tour began, so no trunk or event of it
 * has either as its own, and an hour apart, so a fold that took the instant it folds at for a
 * time the event carries is wrong at one of them at least.
 */
const FOLDED_AT = [Instant(T0 - 1), Instant(T0 - 1 + 60 * 60 * 1000)];

/** The phase a trunk rests in once nothing is being pushed. */
const rests = (queue: readonly Slot[]): Trunk["phase"] =>
  queue.length === 0 ? "idle" : "debouncing";

/** The fold's from-table (state-machines.md § Promotion), typed apart from `evolvePromotion`. */
const trunkFolds = (
  from: FoldedTrunk | undefined,
  event: TrunkEvent,
  at: Instant,
): FoldedTrunk | "illegal" => {
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
          advancedAt: at,
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
            // The group's proofs and committer time are the event's as it names them; its
            // members are its batches', and the event's own list of them is not read.
            group: {
              id: event.groupId,
              old: event.old,
              batches: front,
              proofIds: event.proofIds,
              committerTime: event.committerTime,
            },
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
        advancedAt: at,
        promoted: from.promoted + event.landings.length,
        phase: rests(from.queue),
        ...(event.height === undefined ? {} : { height: event.height }),
      };
    }
    case "PromotionFrozen":
      return (from.phase === "debouncing" && event.expected === from.head) ||
        (from.phase === "promoting" && group !== undefined && group.id === event.groupId) ||
        (from.phase === "syncing" &&
          from.sync !== undefined &&
          syncGroupId(from.sync.to) === event.groupId)
        ? { ...from, phase: "frozen", frozen: true }
        : "illegal";
    case "PromotionResumed": {
      if (from.phase !== "frozen" || (group !== undefined && group.batches.length > 0))
        return "illegal";
      const { group: _dropped, sync: _resolved, ...resumed } = from;
      // Only a resume that names a head trunk is not at moves the time: one that names none (an older event) leaves it.
      const moved = event.head !== undefined && event.head !== from.head;
      return {
        ...resumed,
        frozen: false,
        head: event.head ?? from.head,
        ...(moved ? { advancedAt: at } : {}),
        phase: rests(from.queue),
      };
    }
    case "TrunkSyncStarted":
      return (from.phase === "idle" || from.phase === "debouncing") &&
        event.from === from.head &&
        event.to !== from.head
        ? { ...from, phase: "syncing", sync: { from: event.from, to: event.to } }
        : "illegal";
    case "TrunkSynced": {
      if (
        from.phase !== "syncing" ||
        from.sync?.from !== event.from ||
        from.sync.to !== event.to ||
        (event.height !== undefined &&
          from.height !== undefined &&
          event.height !== from.height + 1)
      )
        return "illegal";
      const { sync: _resolved, height: _was, ...synced } = from;
      return {
        ...synced,
        head: event.to,
        advancedAt: at,
        phase: rests(from.queue),
        ...(event.height === undefined ? {} : { height: event.height }),
      };
    }
    case "BatchDropped": {
      // No tour of this table cancels; `[promotion.drop-fold]` is the drop's table, with the batches dropped already.
      if (from.group?.batches.some((b) => b.batchId === event.batchId) === true) return "illegal";
      const queue = from.queue.filter((b) => b.batchId !== event.batchId);
      return { ...from, queue, phase: from.phase === "debouncing" ? rests(queue) : from.phase };
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
/** A change no batch of the tour holds. */
const STRAY_CHANGE = makeId("chg", ulid(999_999));

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
        // Members and proofs the queue does not hold: the fold takes them as the event names them.
        { ...event, members: [...event.members, STRAY_CHANGE] },
        { ...event, proofIds: [...event.proofIds, "another-proof"] },
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
        // As many landings, one of them another change's, and the group's own out of order.
        {
          ...event,
          landings: event.landings.map((l, i) => (i === 0 ? { ...l, changeId: STRAY_CHANGE } : l)),
        },
        { ...event, landings: event.landings.toReversed() },
        { ...event, height: undefined },
        { ...event, height: (event.height ?? 1) + 1 },
      ];
    case "PromotionFrozen":
      return [event, { ...event, expected: STRAY }, { ...event, groupId: "another-group" }];
    case "PromotionResumed":
      // With no head (an older event), at a head no trunk has, and at each head a trunk of the
      // tour rests at: a resume at the head trunk already has is not one at another.
      return [
        event,
        { ...event, head: undefined },
        { ...event, head: STRAY },
        { ...event, head: H0 },
        { ...event, head: NEW },
      ];
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
 * One state stands for each shape a trunk takes: its phase, whether it knows its height, how
 * many wait, how far the group got and how many batches it holds, and whether it is solo and
 * frozen.
 */
const shapeOf = (t: Trunk | undefined): string =>
  t === undefined
    ? "none"
    : [
        t.phase,
        t.height !== undefined,
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

/**
 * One fold past the tour. A trunk an older Trunk DO advanced without a height does not know its
 * height, and its next advance lands at whatever height it names; every trunk of the tour knows
 * its height. So the trunk the tour first advanced from is built without one, from the group it
 * started, and composed as the tour composed it.
 */
const heightUnknown = (walked: readonly Fold<Trunk, TrunkEvent>[]): Fold<Trunk, TrunkEvent> => {
  const advanced = walked.find((f) => f.event._tag === "TrunkAdvanced");
  const composing = walked.find(
    (f) => f.after === advanced?.before && f.event._tag === "PromotionComposed",
  );
  if (composing?.before === undefined) throw new Error("the tour advances no group it composed");
  const { height: _unknown, ...before } = composing.before;
  return {
    before,
    event: composing.event,
    after: evolvePromotion(before, { at: T0, payload: composing.event }),
  };
};

describe("the Promotion fold", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[promotion.fold-table] the fold takes an event exactly where its table says, lands where it says, and refuses every other as illegal", () => {
    const toured = promotionTour();
    const walked = [...toured, ...frozenUncomposed(toured), heightUnknown(toured)];
    const kinds = new Map<string, TrunkEvent>();
    for (const { event } of walked) if (!kinds.has(event._tag)) kinds.set(event._tag, event);
    // By content: the kit keeps one object for each event's content, the last committed, and
    // the tour commits the same TrunkInitialized each time it starts.
    const firsts = new Set([...kinds.values()].map((e) => canonicalJson(asJson(e))));
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
                proofIds: t.wal.proofIds,
                committerTime: t.wal.committerTime,
                ...(t.wal.composed === undefined ? {} : { composed: t.wal.composed }),
              },
            }),
        solo: t.solo === true,
        frozen: t.frozen !== undefined,
        promoted: t.promoted.length,
        ...(t.advancedAt === undefined ? {} : { advancedAt: t.advancedAt }),
        ...(t.sync === undefined ? {} : { sync: { from: t.sync.from, to: t.sync.to } }),
      }),
      shown: (f) => canonicalJson(asJson(f)),
      row: shapeOf,
      // Every row meets the first event of each kind the tour committed, and every event
      // that names its group, a batch it holds or its head: at most eight of a kind for each
      // of those, so the thousands of freezes that expect its head leave its own group's in.
      meets: (t, event) =>
        (t !== undefined && concerns(t, event)) ||
        (firsts.has(canonicalJson(asJson(event))) && "the first of its kind"),
      most: 8,
      forms: trunkForms,
      times: FOLDED_AT,
      table: trunkFolds,
    });
    const { folded, table } = foldLines(cases);
    expect(folded).toEqual(table);
    // Fifty-five shapes of trunk, eleven of them past the tour: nine frozen on a group never
    // composed, and a group started and composed on a trunk that does not know its height. Each
    // meets at most eight events of a kind for each reason, in every form: 12967 cases at each
    // instant. 528 are the two heightless shapes'; 1470 are forms that vary a start's members or
    // its proofs (413 each, 64 of the 826 taken) or an advance's landings (356 with another
    // change's, 288 reordered, none taken); 10969 are the rest. Twice over, 25934 folds, 2 × 11885
    // of them refused.
    const shape = foldShape(cases);
    expect({ ...shape, rows: shape.rows.length }).toEqual({
      folds: 25934,
      refused: 23770,
      rows: 55,
    });
  });
});

/** Every trunk the sync's walk reaches, each command tried on it as a step would build it. */
const reached = () => {
  const world: World = { touched: new Map(), behind: new Set(), n: 500 };
  return syncTour().flatMap(({ after }) =>
    PROBED.flatMap((kind) =>
      [true, false].flatMap((honest) =>
        [0, 1, 2, 3].map((pick) => ({
          before: after,
          probe: attempt(
            after,
            build(kind, after, { mode: "progress", pick, honest, path: 0, behind: false }, world),
            T0,
          ),
        })),
      ),
    ),
  );
};

describe("a sync from upstream", { timeout: PROPERTY_TIMEOUT }, () => {
  const UP = sha(0x3001);
  const sync = (from: CommitSha = H0, to: CommitSha = UP): PromotionCommand => ({
    _tag: "Sync",
    by: RELEASER,
    from,
    to,
  });
  it("[sync.transitions] in every phase the sync's walk reaches, every command lands where the docs' table says, or is refused", () => {
    const tried = reached();
    const off = tried.filter(({ before, probe }) => {
      const expected = oracle(before, probe.command);
      if (expected === "refused") return !Result.isFailure(probe.result);
      if (expected === "noop")
        return !(Result.isSuccess(probe.result) && probe.result.success.length === 0);
      return !(
        Result.isSuccess(probe.result) &&
        !probe.threw &&
        (probe.after?.phase ?? "none") === expected
      );
    });
    expect(off.map(({ before, probe }) => `${before.phase} ${probe.command._tag}`)).toEqual([]);
    expect(new Set(tried.map(({ before }) => before.phase))).toEqual(
      new Set(["idle", "debouncing", "syncing", "frozen", "promoting"]),
    );
  });

  it("[sync.imported-only] only an imported trunk syncs: an empty, forked or template start, or one with no origin, is NotImported", () => {
    const origins: readonly (TrunkOrigin | undefined)[] = [
      undefined,
      { kind: "empty" },
      { kind: "forked", project: makeId("prj", ulid(2)), commit: H0 },
      { kind: "template", name: "forge", commit: H0 },
    ];
    const refused = origins.map(
      (origin) =>
        failureTag(
          drive([
            {
              _tag: "Initialize",
              head: H0,
              by: "seed",
              ...(origin === undefined ? {} : { origin }),
            },
            sync(),
          ]).results[1],
        ) ?? "taken",
    );
    expect(refused).toEqual(["NotImported", "NotImported", "NotImported", "NotImported"]);
    expect(drive([importedInit, sync()]).tags[1]).toEqual(["TrunkSyncStarted"]);
  });

  it("[sync.phases] a sync starts from idle or debouncing at trunk's own head, and is refused while a group is in flight, a freeze holds or another sync is open", () => {
    const idle = drive([importedInit, sync()]);
    const debouncing = drive([importedInit, enqueue(1, C1), sync()]);
    expect([idle.tags[1], debouncing.tags[2]]).toEqual([
      ["TrunkSyncStarted"],
      ["TrunkSyncStarted"],
    ]);
    expect([idle.state?.phase, debouncing.state?.phase]).toEqual(["syncing", "syncing"]);
    expect(idle.state?.sync).toEqual({
      from: H0,
      to: UP,
      by: RELEASER,
      upstream: { url: IMPORTED.url, ref: IMPORTED.ref },
    });
    const promoting = [importedInit, enqueue(1, C1), flush([facts(1, C1, "src/a.ts")])];
    const refusals = [
      drive([...promoting, sync()]).results[3],
      drive([...promoting, composed, readBack(STRAY), sync(STRAY)]).results[5],
      drive([importedInit, sync(), sync(H0, sha(0x3002))]).results[2],
      drive([importedInit, sync(STRAY)]).results[1],
    ];
    expect(refusals.map(failureTag)).toEqual([
      "PromotionStateRefused",
      "PromotionStateRefused",
      "PromotionStateRefused",
      "PromotionStateRefused",
    ]);
  });

  it("[sync.flush-held] no group starts while a sync is open: a flush is refused, and a batch only queues", () => {
    const open = drive([importedInit, sync(), enqueue(1, C1), flush([facts(1, C1, "src/a.ts")])]);
    expect(open.tags.slice(2)).toEqual([["BatchVerified"], []]);
    expect(failureTag(open.results[3])).toBe("PromotionStateRefused");
    expect(open.state).toMatchObject({ phase: "syncing", head: H0 });
    expect(open.state?.queue.map((b) => b.batchId)).toEqual([makeId("bat", ulid(1))]);
  });

  it("[sync.readback] main read back at the sync's target syncs trunk one height up, at its start leaves the sync open, and anywhere else freezes it", () => {
    const synced = drive([importedInit, sync(), readBack(UP)]);
    expect(synced.tags[2]).toEqual(["TrunkSynced"]);
    expect(eventsOf(synced.results[2]!)[0]).toMatchObject({
      from: H0,
      to: UP,
      by: RELEASER,
      height: 1,
    });
    expect(synced.state).toMatchObject({ phase: "idle", head: UP, height: 1, advancedAt: T0 });
    expect(synced.state?.sync).toBeUndefined();
    const open = drive([importedInit, sync(), readBack(H0)]);
    expect(open.tags[2]).toEqual([]);
    expect(open.state).toMatchObject({ phase: "syncing", head: H0 });
    const stray = drive([importedInit, sync(), readBack(STRAY)]);
    expect(eventsOf(stray.results[2]!)).toEqual([
      PromotionFrozen.make({
        projectId: PROJECT,
        groupId: syncGroupId(UP),
        expected: UP,
        observed: STRAY,
        reason: "readback-mismatch",
      }),
    ]);
    expect(stray.state).toMatchObject({ phase: "frozen", head: H0 });
    const resumed = drive([
      importedInit,
      sync(),
      readBack(STRAY),
      { _tag: "Resume", by: RELEASER, head: STRAY },
    ]);
    expect(resumed.state).toMatchObject({ phase: "idle", head: STRAY });
    expect(resumed.state?.sync).toBeUndefined();
  });

  it("[sync.settles] a sync that lands leaves trunk debouncing when batches queued during it, and idle when none did", () => {
    const queued = drive([importedInit, sync(), enqueue(1, C1), readBack(UP)]);
    const alone = drive([importedInit, sync(), readBack(UP)]);
    expect([queued.state?.phase, alone.state?.phase]).toEqual(["debouncing", "idle"]);
    expect(queued.state?.queue.map((b) => b.batchId)).toEqual([makeId("bat", ulid(1))]);
  });

  it("[sync.level] an upstream at trunk's own head records nothing", () => {
    const level = drive([importedInit, sync(H0, H0)]);
    expect(level.tags[1]).toEqual([]);
    expect(level.state).toMatchObject({ phase: "idle", head: H0 });
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
    const walked = [...promotionTour(), ...syncTour(), ...cancelTour()];
    expect(offChart(promotionChart, walked, promotionView)).toEqual([]);
    expect(uncovered(promotionChart, walked, promotionView)).toEqual([]);
  });
});

/** Every trunk the promotion and cancel tours reach, one of each shape, with none, one or several batches dropped. */
const reachedTrunks = (): readonly Trunk[] => {
  const seen = new Map<string, Trunk>();
  for (const { after } of [...promotionTour(), ...cancelTour()]) {
    const key = `${shapeOf(after)}|${Math.min((after.dropped ?? []).length, 2)}|${after.sync === undefined}`;
    if (!seen.has(key)) seen.set(key, after);
  }
  return [...seen.values()];
};

const folded = (t: Trunk, payload: TrunkEvent): Trunk | "illegal" => {
  try {
    return evolvePromotion(t, { at: T0, payload });
  } catch (error) {
    if (!(error instanceof IllegalTransition)) throw error;
    return "illegal";
  }
};

/** Brings every batch the trunk can promote onto trunk: flush, compose and read back until a flush takes none. */
const settle = (state: Trunk, started: BatchId[], at: number): Trunk => {
  let trunk = state;
  for (let round = 0; round < 6 && trunk.phase === "debouncing"; round += 1) {
    const inputs = trunk.queue.map((b, i) => ({
      batchId: b.batchId,
      touched: footprints(b.members, [PATHS[i % 3] ?? "src/a.ts"]),
      intervening: footprints([], []),
      mergeTreeClean: true,
    }));
    const flushed = attempt(trunk, flush(inputs, trunk.head, `settle-${at}-${round}`), T0);
    trunk = flushed.after ?? trunk;
    for (const event of eventsOf(flushed.result))
      if (event._tag === "PromotionStarted") started.push(...event.batches);
    if (trunk.phase !== "promoting" || trunk.wal === undefined) break;
    const head = sha(0x5000 + at * 8 + round);
    trunk =
      attempt(
        trunk,
        composedAs(
          trunk.wal.batches.flatMap((b) => b.members),
          head,
        ),
        T0,
      ).after ?? trunk;
    trunk = attempt(trunk, readBack(head), T0).after ?? trunk;
  }
  return trunk;
};

const drop = (batchId: BatchId) => BatchDropped.make({ projectId: PROJECT, batchId, because: RED });

describe("a batch speculation cancels", { timeout: PROPERTY_TIMEOUT }, () => {
  const X = makeId("bat", ulid(OUTSIDE + 10));
  const lateX: PromotionCommand = {
    _tag: "Enqueue",
    batchId: X,
    candidateId: makeId("cnd", ulid(OUTSIDE + 10)),
    verdictId: makeId("vrd", ulid(OUTSIDE + 10)),
    members: [C2],
    base: H0,
    predecessors: [C1],
  };
  const cancelX: PromotionCommand = { _tag: "Cancel", batchId: X, because: RED, members: [C2] };

  it("[promotion.cancel-answers] a cancel drops a queued batch or one not seen yet and remembers it, answers a retry the same, refuses the batch's verdict after, and is too late for a batch being pushed or one that landed", () => {
    const queued = drive([init, lateX, cancelX, cancelX, lateX]);
    expect(queued.tags).toEqual([
      ["TrunkInitialized"],
      ["BatchVerified"],
      ["BatchDropped"],
      [],
      [],
    ]);
    expect(failureTag(queued.results[4])).toBe("PromotionStateRefused");
    expect(queued.state).toMatchObject({ phase: "idle", queue: [], dropped: [X] });
    const unseen = drive([init, cancelX, lateX]);
    expect(unseen.tags).toEqual([["TrunkInitialized"], ["BatchDropped"], []]);
    expect(unseen.state).toMatchObject({ phase: "idle", queue: [], dropped: [X] });
    const pushing = drive([
      ...l1Path,
      { _tag: "Cancel", batchId: makeId("bat", ulid(1)), because: RED, members: [C1] },
    ]);
    expect(pushing.results.at(-1)).toEqual(
      Result.fail(expect.objectContaining({ _tag: "CancelTooLate", reason: "promoting" })),
    );
    const landed = drive([
      ...l1Path,
      readBack(NEW),
      { _tag: "Cancel", batchId: makeId("bat", ulid(1)), because: RED, members: [C1] },
    ]);
    expect(landed.results.at(-1)).toEqual(
      Result.fail(expect.objectContaining({ _tag: "CancelTooLate", reason: "promoted" })),
    );
    expect(landed.state?.dropped).toBeUndefined();
  });

  /**
   * Plays a late verdict, its cancel and the batch ahead in `order`, settling the trunk after each
   * when `settling`, then queues the members again only if the cancel was answered dropped: true
   * when the cancelled batch never promoted, the queue emptied, and each member landed once.
   */
  const landsOnce = (order: readonly string[], settling: boolean): boolean => {
    const started: BatchId[] = [];
    let trunk = drive([init]).state;
    let answer: Decision | undefined;
    order.forEach((step, i) => {
      if (trunk === undefined) return;
      const command = step === "verdict" ? lateX : step === "cancel" ? cancelX : enqueue(1, C1);
      const p = attempt(trunk, command, T0);
      if (step === "cancel") answer = p.result;
      trunk = p.after ?? trunk;
      if (settling) trunk = settle(trunk, started, i);
    });
    if (trunk === undefined || answer === undefined) return false;
    trunk = settle(trunk, started, 7);
    const dropped = Result.isSuccess(answer);
    // Only a dropped batch's members go back to the queue, and come again in a batch of their own.
    if (dropped) {
      const again: PromotionCommand = {
        ...lateX,
        batchId: makeId("bat", ulid(OUTSIDE + 11)),
      };
      trunk = settle(attempt(trunk, again, T0).after ?? trunk, started, 8);
    }
    return (
      started.filter((b) => b === X).length === (dropped ? 0 : 1) &&
      trunk.queue.length === 0 &&
      trunk.phase === "idle" &&
      trunk.promoted.filter((c) => c === C2).length === 1 &&
      trunk.promoted.filter((c) => c === C1).length === 1
    );
  };

  it("[promotion.cancel-order] whatever order a batch's late verdict, its cancel and the batch ahead of it arrive in, a dropped batch never promotes and never stops the queue, and each member lands once", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(["verdict", "cancel", "ahead"], { minLength: 3, maxLength: 3 }),
        fc.boolean(),
        landsOnce,
      ),
    );
    // The order the tombstone is for: the cancel first, its verdict after, the batch ahead last.
    expect(landsOnce(["cancel", "verdict", "ahead"], false)).toBe(true);
  });

  it("[promotion.drop-fold] BatchDropped takes a queued batch out of the queue and remembers it, remembers one not seen yet, and is illegal for one being pushed or one dropped already; a dropped batch's verdict is illegal", () => {
    const trunks = reachedTrunks();
    const unseen = makeId("bat", ulid(OUTSIDE + 20));
    let cases = 0;
    for (const t of trunks) {
      const remembered = (id: BatchId, queue: Trunk["queue"]): Trunk => ({
        ...t,
        queue,
        dropped: [...(t.dropped ?? []), id],
        phase: t.phase === "debouncing" && queue.length === 0 ? "idle" : t.phase,
      });
      const expected: [BatchId, Trunk | "illegal"][] = [
        ...t.queue.map((b): [BatchId, Trunk] => [
          b.batchId,
          remembered(
            b.batchId,
            t.queue.filter((q) => q.batchId !== b.batchId),
          ),
        ]),
        ...(t.wal?.batches ?? []).map((b): [BatchId, "illegal"] => [b.batchId, "illegal"]),
        ...(t.dropped ?? []).map((id): [BatchId, "illegal"] => [id, "illegal"]),
        [unseen, remembered(unseen, t.queue)],
      ];
      for (const [id, want] of expected) {
        cases += 1;
        const got = folded(t, drop(id));
        expect(got === "illegal" ? got : comparable(got)).toBe(
          want === "illegal" ? want : comparable(want),
        );
      }
      for (const id of t.dropped ?? []) {
        cases += 1;
        const verdict = eventsOf(decidePromotion(undefined, init, { now: T0, projectId: PROJECT }));
        expect(verdict.length).toBe(1);
        expect(
          folded(t, {
            _tag: "BatchVerified",
            batchId: id,
            candidateId: makeId("cnd", ulid(OUTSIDE + 21)),
            verdictId: makeId("vrd", ulid(OUTSIDE + 21)),
            members: [C2],
            base: t.head,
            predecessors: [],
          }),
        ).toBe("illegal");
      }
    }
    // The tours reach trunks with batches queued, being pushed and dropped: every row meets each.
    expect(trunks.some((t) => t.queue.length > 0)).toBe(true);
    expect(trunks.some((t) => (t.wal?.batches.length ?? 0) > 0)).toBe(true);
    expect(trunks.some((t) => (t.dropped?.length ?? 0) > 0)).toBe(true);
    expect(cases).toBeGreaterThan(trunks.length);
  });
});
