import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  commutation,
  type CommutationFacts,
  decidePromotion,
  evolvePromotion,
  type Footprints,
  type PromotionCommand,
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
  Glob,
  IllegalTransition,
  Instant,
  type Json,
  makeId,
} from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

const T0 = Instant(1_760_000_000_000);
const ulid = (n: number): string => String(n).padStart(26, "0");
const PROJECT = makeId("prj", ulid(1));
const sha = (n: number): CommitSha => CommitSha.make(n.toString(16).padStart(40, "0"));
const H0 = sha(1);
const STRAY = sha(0xdead);
const PATHS = ["src/a.ts", "src/b.ts", "src/c.ts", "pnpm-lock.yaml"] as const;
const BARRIERS = [Glob.make("pnpm-lock.yaml")];

type Kind = PromotionCommand["_tag"];
type Phase = "none" | Trunk["phase"];
type Decision = ReturnType<typeof decidePromotion>;

const KINDS: readonly Kind[] = ["Initialize", "Enqueue", "Flush", "Composed", "ReadBack", "Resume"];
const PROGRESS: Readonly<Record<Phase, readonly Kind[]>> = {
  none: ["Initialize"],
  idle: ["Enqueue"],
  debouncing: ["Flush", "Flush", "Enqueue"],
  promoting: ["Composed", "ReadBack", "ReadBack", "Enqueue"],
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
        members: [makeId("chg", ulid(n))],
        base: state?.head ?? H0,
        predecessors,
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
    case "Composed":
      return {
        _tag: "Composed",
        sha: step.honest ? (state?.wal?.composed ?? sha(0x1000 + n)) : sha(0x2000 + n),
      };
    case "ReadBack": {
      const wal = state?.wal;
      const observed = !step.honest
        ? STRAY
        : step.pick % 3 === 0
          ? (wal?.old ?? H0)
          : (wal?.composed ?? H0);
      return { _tag: "ReadBack", observed };
    }
    case "Resume":
      return {
        _tag: "Resume",
        by: "operator:zb",
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
    played.push({ before, probes, taken, after: state, log: [...log] });
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
    else group.push({ id: b.batchId, touched: facts.touched, members: b.members });
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
      if (wal.composed === undefined) return "promoting";
      return command.sha === wal.composed ? "noop" : "frozen";
    case "ReadBack":
      if (before.phase !== "promoting" || wal?.composed === undefined) return "refused";
      if (command.observed === wal.old) return "noop";
      return command.observed === wal.composed ? settled(before, 0) : "frozen";
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
): PromotionCommand => ({
  _tag: "Flush",
  observedHead,
  groupId: "group-1",
  committerTime: T0,
  barriers: BARRIERS,
  inputs,
});
const NEW = sha(0x1001);
const composed: PromotionCommand = { _tag: "Composed", sha: NEW };
const readBack = (observed: CommitSha): PromotionCommand => ({ _tag: "ReadBack", observed });
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
    fc.assert(
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
            recomposes++;
            return tagsOf(p.result).join() === "PromotionFrozen";
          });
        }),
      ),
    );
    expect(recomposes).toBeGreaterThan(0);
    expect(drive([...l1Path, { _tag: "Composed", sha: sha(0x3000) }]).tags.at(-1)).toEqual([
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
    });
    expect(
      drive([init, enqueue(1, C1), flush([facts(1, C1, "src/a.ts")], STRAY)]).state?.phase,
    ).toBe("frozen");
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
      { _tag: "Resume", by: "operator:zb", head: STRAY },
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
    fc.assert(
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

  it("[promotion.group-resolves-once] every WAL group ends exactly once, advanced or frozen", () => {
    let groups = 0;
    fc.assert(
      fc.property(planArb, (steps) => {
        const played = run(steps);
        const log = played.at(-1)?.log ?? [];
        let open: string | undefined;
        for (const { payload: e } of log) {
          if (e._tag === "PromotionStarted") {
            groups++;
            if (open !== undefined) return false;
            open = e.groupId;
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
