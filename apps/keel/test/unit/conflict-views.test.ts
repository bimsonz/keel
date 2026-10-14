import { describe, expect, it } from "@effect/vitest";
import { probeIdOf, readProbeSource } from "@keeltown/core/application/coordination";
import { isOpenConflict, matrixOf, sidesOf } from "@keeltown/core/application/memory";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import {
  type ConflictCommand,
  type ConflictState,
  type ProbeOutcome,
  World,
} from "@keeltown/core/domain/verification";
import {
  type EntityRef,
  ChangeId,
  ConflictId,
  ContentHash,
  type EventEnvelope,
  makeId,
  ProbeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import {
  type ConflictListRead,
  ProbeLedger,
  ProbeStore,
  ProjectViews,
  type SubjectRef,
} from "@keeltown/core/ports";
import {
  makeProbeLedgerMemory,
  makePlacedProject,
  makeProjectNamespacesMemory,
  makeProbeStoreMemory,
  makeProjectViewsMemory,
  otherNamespace,
  projectEvents,
  sampleNamespace,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import * as fc from "fast-check";
import { conflictOk } from "../../src/adapters/driving/http/views.ts";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 150, ...(seed === undefined ? {} : { seed: Number(seed) }) });

/**
 * Each property plays 150 runs through the real in-memory ledger and the fold.
 * Run alone one takes about a second; inside the full unit suite on a busy
 * machine it has passed vitest's 5 s default, so it gets a minute instead of
 * fewer runs (fewer runs would weaken every mutant's proof).
 */
const PROPERTY_TIMEOUT = 60_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let made = 0;
/** Distinct ids without randomness, so a seeded run replays exactly. */
const nextId = (prefix: string) => {
  made += 1;
  let n = made;
  let tail = "";
  for (let i = 0; i < 26; i += 1) {
    tail = (CROCKFORD[n % 32] ?? "0") + tail;
    n = Math.floor(n / 32);
  }
  return `${prefix}_${tail}`;
};

const KEY = Schema.decodeUnknownSync(SubjectKey)("authz.permission-evaluation");
const BUNDLE = ContentHash.make(`sha256:${"a".repeat(64)}`);
const WORLDS = World.literals;
const RUNS = [1, 2, 3] as const;
const CELLS = WORLDS.flatMap((world) => RUNS.map((run) => ({ world, run })));
/** What a discriminating probe answers in each world. */
const DISCRIMINATES: Readonly<Record<World, ProbeOutcome>> = {
  trunk: "pass",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};

type Views = ReturnType<typeof makeProjectViewsMemory>;
const reading = <A, E>(
  views: Views,
  read: (v: (typeof ProjectViews)["Service"]) => Effect.Effect<A, E>,
) => Effect.runSync(ProjectViews.use(read).pipe(Effect.provide(views.layer)));
const record = (views: Views, project: ProjectId, conflictId: string) =>
  reading(views, (v) => v.conflict(project, ConflictId.make(conflictId)));
const listing = (views: Views, read: ConflictListRead) => reading(views, (v) => v.conflicts(read));

/** A conflict suspected on the real ledger, between a premise's holder and an effect's change. */
function suspectedOnLedger() {
  const ledger = makeProbeLedgerMemory();
  const at: SubjectRef = { projectId: makeId("prj", nextId("x").slice(2)), key: KEY };
  const conflictId = makeId("cfl", nextId("x").slice(2));
  const [holder, other] = [
    makeId("chg", nextId("x").slice(2)),
    makeId("chg", nextId("x").slice(2)),
  ];
  const suspect: Extract<ConflictCommand, { _tag: "Suspect" }> = {
    _tag: "Suspect",
    kind: "semantic",
    parties: [holder, other],
    subjectId: makeId("sub", nextId("x").slice(2)),
    subjectKey: KEY,
    predicate: "freshness",
    origin: "fallout",
    premise: {
      holder,
      proposition: {
        subject: KEY,
        predicate: "freshness",
        relation: "at-most",
        value: "per-request",
      },
    },
    effect: {
      changeId: other,
      proposition: { subject: KEY, predicate: "freshness", relation: "is", value: "per-session" },
    },
  };
  Effect.runSync(ledger.suspect(at, conflictId, suspect));
  return { ledger, at, conflictId, holder, other };
}

type OnLedger = ReturnType<typeof suspectedOnLedger>;

/** One fact reported to the ledger; a refusal commits nothing, and that is part of what is compared. */
type Step =
  | { readonly _tag: "draft" }
  | { readonly _tag: "draft-failed" }
  | {
      readonly _tag: "cell";
      readonly world: World;
      readonly run: number;
      readonly outcome: ProbeOutcome;
    }
  | {
      readonly _tag: "check";
      readonly world: World;
      readonly who: "holder" | "other" | "trunk";
      readonly run: number;
      readonly outcome: ProbeOutcome;
    };

const report = ({ ledger, at, conflictId, holder, other }: OnLedger, step: Step) => {
  const probeId = probeIdOf(conflictId);
  const call = ProbeLedger.use((l) => {
    switch (step._tag) {
      case "draft":
        return l.probeDrafted(at, { conflictId, attempts: 1, bundleHash: BUNDLE });
      case "draft-failed":
        return l.probeDraftFailed(at, { conflictId, attempts: 4, reason: "abstained" });
      case "cell":
        return l.probeCellRan(at, {
          conflictId,
          probeId,
          world: step.world,
          run: step.run,
          outcome: step.outcome,
          resultRef: `result:${step.world}:${step.run}`,
        });
      case "check":
        return l.worldCheckRan(at, {
          conflictId,
          world: step.world,
          check: `suite:${step.who === "trunk" ? "trunk" : step.who === "holder" ? holder : other}`,
          run: step.run,
          outcome: step.outcome,
          ...(step.outcome === "n/a"
            ? { reason: "the suite has no test here" }
            : { counts: { passed: 7, failed: step.outcome === "fail" ? 1 : 0, skipped: 0 } }),
        });
      default: {
        const unreachable: never = step;
        return unreachable;
      }
    }
  });
  Effect.runSync(Effect.result(call).pipe(Effect.provide(ledger.layer)));
};

/** What the subject has committed about the conflict's probe and the conflict, each in its own order. */
const committed = ({ ledger, at, conflictId }: OnLedger) => ({
  probe: Effect.runSync(ledger.log(at, { kind: "probe", id: probeIdOf(conflictId) })),
  conflict: Effect.runSync(ledger.log(at, { kind: "conflict", id: conflictId })),
});

/**
 * Delivers what the subject committed since the last delivery, as its outbox
 * does: a step's probe events come ahead of the settle they cause on the
 * conflict.
 */
function deliverer(on: OnLedger, views: Views) {
  const seen = { probe: 0, conflict: 0 };
  return () => {
    const { probe, conflict } = committed(on);
    for (const event of [...probe.slice(seen.probe), ...conflict.slice(seen.conflict)])
      Effect.runSync(views.arrive(event));
    seen.probe = probe.length;
    seen.conflict = conflict.length;
  };
}

const truth = ({ ledger, at, conflictId }: OnLedger) =>
  Effect.runSync(
    ProbeLedger.use((l) => l.conflict(at, conflictId)).pipe(Effect.provide(ledger.layer)),
  );

const payloadsOf = (log: readonly EventEnvelope[], type: string) =>
  log
    .filter((event) => event.type === type)
    .map((event) => ({ ...Object(event.payload), at: event.at }));

const arbitraryStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Step>({ _tag: "draft" }) },
  { weight: 1, arbitrary: fc.constant<Step>({ _tag: "draft-failed" }) },
  {
    weight: 3,
    arbitrary: fc.record({
      _tag: fc.constant("check" as const),
      world: fc.constantFrom(...WORLDS),
      who: fc.constantFrom("holder" as const, "other" as const, "trunk" as const),
      run: fc.constantFrom(...RUNS),
      outcome: fc.constantFrom<ProbeOutcome>("pass", "fail", "n/a"),
    }),
  },
);

/** A whole calibration in some order, mostly discriminating so that many runs reach an admission or a discard. */
const arbitraryRun = fc
  .record({
    drafted: fc.constantFrom<Step["_tag"]>("draft", "draft", "draft", "draft-failed"),
    // Half the time every cell runs, so an admission (three whole discriminating runs) is reachable.
    order: fc.oneof(
      fc.shuffledSubarray(CELLS, { minLength: CELLS.length }),
      fc.shuffledSubarray(CELLS, { minLength: 4 }),
    ),
    // One cell in sixteen answers something a discriminating probe would not.
    odd: fc.array(
      fc.oneof(
        { weight: 15, arbitrary: fc.constant(undefined) },
        { weight: 1, arbitrary: fc.constantFrom<ProbeOutcome>("pass", "fail", "n/a") },
      ),
      { minLength: CELLS.length, maxLength: CELLS.length },
    ),
    extra: fc.array(fc.tuple(fc.nat(CELLS.length), arbitraryStep), { maxLength: 8 }),
  })
  .map(({ drafted, order, odd, extra }): Step[] => {
    const steps: Step[] = [
      drafted === "draft" ? { _tag: "draft" } : { _tag: "draft-failed" },
      ...order.map((cell, n): Step => ({
        _tag: "cell",
        ...cell,
        outcome: odd[n] ?? DISCRIMINATES[cell.world],
      })),
    ];
    for (const [at, step] of extra) steps.splice(Math.min(at, steps.length), 0, step);
    return steps;
  });

describe(
  "[b23.conflict-fold] the Projector's view of a conflict agrees with the subject that hosts it",
  { timeout: PROPERTY_TIMEOUT },
  () => {
    it("[b23.conflict-fold] after every fact the ledger takes or refuses, the folded conflict and probe equal the ledger's own, with every run and suite cell its events carried", () => {
      const reached = new Set<ConflictState | "admitted" | "discarded">();
      fc.assert(
        fc.property(arbitraryRun, (steps) => {
          const on = suspectedOnLedger();
          const views = makeProjectViewsMemory();
          const deliver = deliverer(on, views);
          deliver();
          for (const step of steps) {
            report(on, step);
            deliver();
            const folded = record(views, on.at.projectId, on.conflictId);
            const hosted = truth(on);
            expect(folded.conflict).toEqual(hosted.conflict);
            expect(folded.probe).toEqual(hosted.probe);
          }
          const folded = record(views, on.at.projectId, on.conflictId);
          const { probe, conflict } = committed(on);
          expect(folded.runs).toEqual(
            payloadsOf(probe, "ProbeRan").map(({ world, run, outcome, resultRef, at }) => ({
              world,
              run,
              outcome,
              resultRef,
              at,
            })),
          );
          expect(folded.checks).toEqual(
            payloadsOf(conflict, "WorldCheckRan").map(
              ({ _tag: _type, conflictId: _conflict, ...check }) => check,
            ),
          );
          const admission = payloadsOf(probe, "GuardAdmitted").at(0);
          expect(folded.guard).toEqual(
            admission === undefined
              ? undefined
              : {
                  id: admission.guardId,
                  probeId: admission.probeId,
                  runs: admission.runs,
                  admittedAt: admission.at,
                },
          );
          expect(folded.draftFailure).toEqual(payloadsOf(probe, "ProbeDiscarded").at(0)?.detail);
          expect(folded.settledAt).toEqual(payloadsOf(conflict, "ConflictDismissed").at(0)?.at);
          expect(folded.proven).toEqual(payloadsOf(conflict, "ConflictProven").at(0)?.evidence);
          expect(folded.labels.conflict).toBe("C-1");
          expect(folded.labels.probe).toBe(folded.probe === undefined ? undefined : "P-1");
          expect(folded.labels.guard).toBe(folded.guard === undefined ? undefined : "G-1");
          expect(views.skipped).toEqual([]);
          reached.add(folded.conflict.state);
          if (folded.probe?.state === "admitted" || folded.probe?.state === "discarded")
            reached.add(folded.probe.state);
        }),
      );
      // The generator must reach every outcome the fold branches on.
      expect([...reached].toSorted()).toEqual(
        ["admitted", "discarded", "dismissed", "probing", "proven", "suspected"].toSorted(),
      );
    });
  },
);

describe("[b23.conflict-matrix] the world matrix of a conflict", () => {
  it("[b23.conflict-matrix] always five worlds in order, the probe's runs in run order, each suite by its latest run, and nothing where nothing was recorded", () => {
    const views = makeProjectViewsMemory();
    const events = projectEvents();
    const [conflictId, probeId] = [nextId("cfl"), nextId("prb")];
    const [holder, other] = [nextId("chg"), nextId("chg")];
    const counts = { passed: 12, failed: 0, skipped: 1 };
    for (const event of [
      events.suspected(conflictId, holder, other),
      events.probeDrafted(conflictId, probeId),
      events.probeRan(conflictId, probeId, "AB", 2, "fail"),
      events.probeRan(conflictId, probeId, "AB", 1, "fail"),
      events.probeRan(conflictId, probeId, "trunk", 1, "pass"),
      events.worldCheckRan(conflictId, "AB", `suite:${other}`, 1, "fail", {
        passed: 11,
        failed: 1,
        skipped: 1,
      }),
      events.worldCheckRan(conflictId, "AB", `suite:${holder}`, 2, "pass", counts),
      events.worldCheckRan(conflictId, "AB", `suite:${other}`, 3, "pass", counts),
      events.worldCheckRan(conflictId, "AB", `suite:${other}`, 2, "n/a"),
      events.worldCheckRan(conflictId, "B", "suite:trunk", 1, "pass", counts),
    ])
      Effect.runSync(views.arrive(event));
    const matrix = matrixOf(record(views, events.project, conflictId));

    expect(matrix.map((row) => row.world)).toEqual(["trunk", "A-noop", "A", "B", "AB"]);
    expect(matrix.map((row) => row.probe.map((run) => run.run))).toEqual([[1], [], [], [], [1, 2]]);
    expect(matrix.map((row) => row.checks.map((check) => [check.check, check.run]))).toEqual([
      [],
      [],
      [],
      [["suite:trunk", 1]],
      [
        [`suite:${holder}`, 2],
        [`suite:${other}`, 3],
      ].toSorted(([a = ""], [b = ""]) => String(a).localeCompare(String(b))),
    ]);
    const latest = matrix.at(4)?.checks.find((check) => check.check === `suite:${other}`);
    expect(latest).toMatchObject({ outcome: "pass", counts });
    expect(views.skipped).toEqual([]);
  });
});

describe("[b23.conflict-endings] a conflict past its proof", () => {
  it("[b23.conflict-endings] escalated, resolved by a decision and its guard retired: each is folded, the guard found by its own id, and served in the events' words", () => {
    const views = makeProjectViewsMemory();
    const events = projectEvents();
    const [conflictId, probeId, guardId] = [nextId("cfl"), nextId("prb"), nextId("grd")];
    const [escalationId, decisionId] = [nextId("esc"), nextId("dec")];
    const [holder, other] = [nextId("chg"), nextId("chg")];
    const conflict = { kind: "conflict", id: conflictId };
    const arrivals = [
      events.suspected(conflictId, holder, other),
      events.probeDrafted(conflictId, probeId),
      ...RUNS.flatMap((run) =>
        (["trunk", "A", "AB", "A-noop"] as const).map((world) =>
          events.probeRan(conflictId, probeId, world, run, DISCRIMINATES[world]),
        ),
      ),
      events.guardAdmitted(conflictId, probeId, guardId),
      events.proven(conflictId, probeId),
      events.of(conflict, {
        _tag: "ConflictEscalated",
        conflictId,
        escalationId,
        reason: "human-class",
      } as { _tag: string }),
    ];
    for (const event of arrivals) Effect.runSync(views.arrive(event));
    const escalated = conflictOk(record(views, events.project, conflictId), "members");
    const resolved = events.of(conflict, {
      _tag: "ConflictResolved",
      conflictId,
      move: "escalate",
      decisionId,
    } as { _tag: string });
    Effect.runSync(views.arrive(resolved));
    Effect.runSync(
      views.arrive(
        events.of({ kind: "probe", id: probeId }, {
          _tag: "GuardRetired",
          guardId,
          decisionId,
        } as { _tag: string }),
      ),
    );
    const folded = record(views, events.project, conflictId);
    const served = conflictOk(folded, "members");

    expect(escalated.body).toMatchObject({
      state: "escalated",
      escalation: { id: escalationId, open: true, reason: "human-class" },
      guard: { id: guardId, label: "G-1", state: "admitted" },
    });
    expect(folded).toMatchObject({
      conflict: { state: "resolved", escalationId, decisionId, move: "escalate" },
      probe: { state: "retired", retiredBy: decisionId },
      escalated: "human-class",
      settledAt: resolved.at,
    });
    expect(folded.guard?.retiredAt).toBeGreaterThan(resolved.at);
    expect(served.body).toMatchObject({
      state: "resolved",
      settledAt: new Date(resolved.at).toISOString(),
      escalation: { id: escalationId, open: false, reason: "human-class" },
      decision: { id: decisionId },
      move: "escalate",
      probe: { id: probeId, state: "retired" },
      guard: { id: guardId, state: "retired", probeId, runs: 3 },
    });
    expect(views.skipped).toEqual([]);
    expect(isOpenConflict(folded.conflict.state)).toBe(false);
  });
});

describe("[b23.conflict-sides] the two sides of a conflict, as Keel knows them", () => {
  it("[b23.conflict-sides] the holder is the premise's and the other the effect's, each with its own proposition; a conflict suspected without them has no sides", () => {
    const views = makeProjectViewsMemory();
    const events = projectEvents();
    const [named, bare] = [nextId("cfl"), nextId("cfl")];
    const [holder, other] = [nextId("chg"), nextId("chg")];
    Effect.runSync(views.arrive(events.suspected(named, holder, other)));
    Effect.runSync(
      views.arrive(
        events.of({ kind: "conflict", id: bare }, {
          _tag: "ConflictSuspected",
          conflictId: bare,
          kind: "textual",
          parties: [holder, other],
        } as { _tag: string }),
      ),
    );

    expect(sidesOf(record(views, events.project, named))).toEqual({
      holder: {
        changeId: holder,
        role: "premise",
        proposition: {
          subject: KEY,
          predicate: "freshness",
          relation: "at-most",
          value: "per-request",
          strength: "must",
        },
      },
      other: {
        changeId: other,
        role: "effect",
        proposition: { subject: KEY, predicate: "freshness", relation: "is", value: "per-session" },
      },
    });
    expect(sidesOf(record(views, events.project, bare))).toBeUndefined();

    // How the effect is known rides the effect's side only, and is served as it was judged.
    const [declared, derived] = [nextId("cfl"), nextId("cfl")];
    const testimony = { declared: true, evidenceClass: "testimony" };
    const ruling = { declared: false, method: "extractor", evidenceClass: "ruling" };
    Effect.runSync(views.arrive(events.suspected(declared, holder, other, testimony)));
    Effect.runSync(views.arrive(events.suspected(derived, holder, other, ruling)));
    const folded = (conflictId: string) => sidesOf(record(views, events.project, conflictId));
    const served = (conflictId: string) =>
      conflictOk(record(views, events.project, conflictId), "members").body;
    expect([folded(declared)?.holder.evidence, folded(declared)?.other.evidence]).toEqual([
      undefined,
      testimony,
    ]);
    expect(folded(derived)?.other.evidence).toEqual(ruling);
    expect(folded(named)?.other.evidence).toBeUndefined();
    expect(served(declared)).toHaveProperty("sides.other.evidence", testimony);
    expect(served(derived)).toHaveProperty("sides.other.evidence", ruling);
    for (const conflictId of [declared, derived])
      expect(served(conflictId)).not.toHaveProperty("sides.holder.evidence");
    expect(served(named)).not.toHaveProperty("sides.other.evidence");
  });
});

describe("[b23.conflict-told] what a party was told about a conflict", () => {
  it("[b23.conflict-told] a bounce citing the conflict and a note of it reach their own side, the latest standing; another conflict's bounce and a bounce for another cause tell nothing", () => {
    const views = makeProjectViewsMemory();
    const events = projectEvents();
    const [conflictId, elsewhere] = [nextId("cfl"), nextId("cfl")];
    const [holder, other] = [nextId("chg"), nextId("chg")];
    const noted = (changeId: string, about: string) =>
      events.of({ kind: "change", id: changeId }, {
        _tag: "ConflictNoted",
        changeId,
        conflictId: about,
        predicate: "freshness",
        policy: "advise",
        nextActions: [{ kind: "call", title: "Revise the change", operationId: "revise" }],
      } as { _tag: string });
    const refused = events.of({ kind: "change", id: holder }, {
      _tag: "ChangeBounced",
      changeId: holder,
      verdictId: nextId("vrd"),
      reasons: ["precheck:protected:src/secret.ts"],
      nextActions: [{ kind: "call", title: "Submit it again", operationId: "submit" }],
    } as { _tag: string });
    for (const event of [
      events.bounced(other, conflictId),
      events.suspected(conflictId, holder, other),
      events.suspected(elsewhere, holder, other),
      events.bounced(holder, elsewhere),
      refused,
      noted(other, conflictId),
    ])
      Effect.runSync(views.arrive(event));
    const sides = sidesOf(record(views, events.project, conflictId));

    expect(sides?.holder.told).toBeUndefined();
    expect(sides?.other.told).toMatchObject({
      changeId: other,
      how: "noted",
      nextActions: [{ operationId: "revise" }],
    });
    expect(sidesOf(record(views, events.project, elsewhere))?.holder.told).toMatchObject({
      how: "bounced",
    });
  });
});

const ENDINGS = ["suspected", "probing", "dismissed"] as const;

describe(
  "[b23.conflict-list] a project's conflicts as a list",
  { timeout: PROPERTY_TIMEOUT },
  () => {
    it("[b23.conflict-list] [b23.conflict-totals] walking the pages yields the asked conflicts newest C-n first, each once, and every page carries the open and settled totals of the project, or of the change asked for", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              mine: fc.boolean(),
              ending: fc.constantFrom(...ENDINGS),
              third: fc.boolean(),
            }),
            { maxLength: 20 },
          ),
          fc.integer({ min: 1, max: 6 }),
          fc.option(fc.boolean(), { nil: undefined }),
          fc.option(fc.constantFrom<ConflictState>(...ENDINGS, "proven"), { nil: undefined }),
          fc.boolean(),
          (conflicts, limit, open, state, ofThird) => {
            const views = makeProjectViewsMemory();
            const mine = projectEvents();
            const theirs = projectEvents();
            const [holder, other, third] = [nextId("chg"), nextId("chg"), nextId("chg")];
            const changeId = ofThird ? ChangeId.make(third) : undefined;
            const numbered: { number: number; ending: ConflictState; third: boolean }[] = [];
            for (const conflict of conflicts) {
              const events = conflict.mine ? mine : theirs;
              const conflictId = nextId("cfl");
              const arrivals = [
                events.suspected(conflictId, holder, conflict.third ? third : other),
                ...(conflict.ending === "probing"
                  ? [events.probeDrafted(conflictId, nextId("prb"))]
                  : []),
                ...(conflict.ending === "dismissed" ? [events.dismissed(conflictId)] : []),
              ];
              for (const event of arrivals) Effect.runSync(views.arrive(event));
              if (conflict.mine)
                numbered.push({
                  number: numbered.length + 1,
                  ending: conflict.ending,
                  third: conflict.third,
                });
            }
            const counted = numbered.filter((c) => !ofThird || c.third);
            const expected = counted
              .filter(
                (c) =>
                  (open === undefined || isOpenConflict(c.ending) === open) &&
                  (state === undefined || c.ending === state),
              )
              .map((c) => c.number)
              .toSorted((a, b) => b - a);
            const totals = {
              open: counted.filter((c) => isOpenConflict(c.ending)).length,
              settled: counted.filter((c) => !isOpenConflict(c.ending)).length,
            };
            const walked: number[] = [];
            let cursor: number | undefined;
            for (let pages = 0; pages <= conflicts.length + 1; pages += 1) {
              const page = listing(views, {
                project: mine.project,
                open,
                state,
                changeId,
                cursor,
                limit,
              });
              walked.push(...page.items.map((item) => item.number));
              expect(page.items.length).toBeLessThanOrEqual(limit);
              expect(page.totals).toEqual(totals);
              cursor = page.nextCursor;
              if (cursor === undefined) break;
            }
            expect(walked).toEqual(expected);
            expect(views.skipped).toEqual([]);
          },
        ),
      );
    });
  },
);

/** A fresh id of one kind, distinct across the file. */
const fresh = (prefix: "prb" | "cfl" | "chg") => makeId(prefix, nextId("x").slice(2));

describe("[b23.probe-source] a probe's source, from the bundle its draft was kept under", () => {
  it.effect(
    "[b23.probe-source] the kept bundle's files are answered with its hash; a bundle no longer kept leaves the hash and no files, a probe never drafted has neither, and a probe the project does not have is not found",
    () => {
      const views = makeProjectViewsMemory();
      const store = makeProbeStoreMemory();
      const mine = projectEvents();
      const theirs = projectEvents();
      const places = makePlacedProject(mine.project);
      const [probeId, lost, undrafted, unknown, elsewhere] = [
        ProbeId.make(fresh("prb")),
        ProbeId.make(fresh("prb")),
        ProbeId.make(fresh("prb")),
        ProbeId.make(fresh("prb")),
        ProbeId.make(fresh("prb")),
      ];
      const files = [
        { path: ".keel/freshness.test.ts", text: "test('freshness', () => {});\n" },
        { path: ".keel/support/actors.ts", text: "export const actors = [];\n" },
      ];
      const scope = { project: mine.project, audience: "public" } as const;
      const opened = (probe: (conflictId: string) => EventEnvelope) => {
        const conflictId = fresh("cfl");
        return Effect.andThen(
          views.arrive(mine.suspected(conflictId, fresh("chg"), fresh("chg"))),
          views.arrive(probe(conflictId)),
        );
      };
      return Effect.gen(function* () {
        const kept = yield* (yield* ProbeStore).put(sampleNamespace, files.toReversed());
        yield* opened((conflictId) => mine.probeDrafted(conflictId, probeId, kept));
        // A bundle kept for another namespace only: not this project's to read.
        const theirBundle = yield* (yield* ProbeStore).put(otherNamespace, [
          { path: ".keel/other.test.ts", text: "test('another namespace', () => {});\n" },
        ]);
        yield* opened((conflictId) => mine.probeDrafted(conflictId, elsewhere, theirBundle));
        yield* opened((conflictId) => mine.probeDrafted(conflictId, lost));
        yield* opened((conflictId) => mine.probeDraftFailed(conflictId, undrafted));

        expect(yield* readProbeSource(scope, probeId)).toEqual({
          probeId,
          bundleHash: kept,
          files,
        });
        const gone = yield* readProbeSource(scope, lost);
        expect(gone).toEqual({ probeId: lost, bundleHash: gone.bundleHash, files: [] });
        expect(gone.bundleHash).toMatch(/^sha256:a{64}$/);
        expect(yield* readProbeSource(scope, elsewhere)).toEqual({
          probeId: elsewhere,
          bundleHash: theirBundle,
          files: [],
        });
        expect(yield* readProbeSource(scope, undrafted)).toEqual({ probeId: undrafted, files: [] });
        expect(yield* Effect.flip(readProbeSource(scope, unknown))).toMatchObject({
          _tag: "ProbeNotFound",
          probeId: unknown,
        });
        expect(
          yield* Effect.flip(readProbeSource({ ...scope, project: theirs.project }, probeId)),
        ).toMatchObject({ _tag: "ProbeNotFound", probeId });
      }).pipe(Effect.provide(Layer.mergeAll(views.layer, store.layer, places.layer)));
    },
  );
});

describe("[t5.probe-source.unplaced] a probe's source, for a project with no place", () => {
  it.effect(
    "[t5.probe-source.unplaced] a probe of a project with no place answers its bundle's hash and no files",
    () => {
      const views = makeProjectViewsMemory();
      const store = makeProbeStoreMemory();
      const mine = projectEvents();
      const probeId = ProbeId.make(fresh("prb"));
      const conflictId = fresh("cfl");
      return Effect.gen(function* () {
        // Kept for a namespace, but the project belongs to none: there is no namespace to read it under.
        const kept = yield* (yield* ProbeStore).put(sampleNamespace, [
          { path: ".keel/freshness.test.ts", text: "test('freshness', () => {});\n" },
        ]);
        yield* views.arrive(mine.suspected(conflictId, fresh("chg"), fresh("chg")));
        yield* views.arrive(mine.probeDrafted(conflictId, probeId, kept));
        expect(
          yield* readProbeSource({ project: mine.project, audience: "public" }, probeId),
        ).toEqual({ probeId, bundleHash: kept, files: [] });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(views.layer, store.layer, makeProjectNamespacesMemory().layer),
        ),
      );
    },
  );
});

describe("a conflict's escalation on its own page", () => {
  it("[b23.conflict-escalation] a member reads the question, its state, its options and its evidence, and what the decision chose; another reader of a public project is told a person was asked and what was chosen, and nothing of the question", () => {
    const views = makeProjectViewsMemory();
    const events = projectEvents(nextId("prj"));
    const [conflictId, probeId, escalationId, decisionId] = [
      nextId("cfl"),
      nextId("prb"),
      nextId("esc"),
      nextId("dec"),
    ];
    const [holder, other] = [nextId("chg"), nextId("chg")];
    const conflict: EntityRef = { kind: "conflict", id: conflictId };
    const escalation: EntityRef = { kind: "escalation", id: escalationId };
    const concerning: readonly EntityRef[] = [
      conflict,
      { kind: "org", id: nextId("org") },
      { kind: "user", id: nextId("usr") },
    ];
    const options = [
      { id: "premise-holds", label: "The premise holds", consequence: "the other gives way" },
      { id: "effect-stands", label: "The effect stands", consequence: "the holder gives way" },
    ];
    const evidence = [
      { class: "proof", summary: "a probe tells them apart", ref: `probe:${probeId}` },
    ];
    const arrivals = [
      events.suspected(conflictId, holder, other),
      events.probeDrafted(conflictId, probeId),
      events.proven(conflictId, probeId),
      {
        ...events.of(escalation, {
          _tag: "EscalationRaised",
          escalationId,
          question: "Which holds?",
          options,
          about: conflict,
          category: "ambiguous-requirement",
          evidence,
          precedents: [],
          default: "premise-holds",
        } as { _tag: string }),
        affected: concerning,
      },
      events.of(conflict, {
        _tag: "ConflictEscalated",
        conflictId,
        escalationId,
        reason: "human-class",
      } as { _tag: string }),
    ];
    for (const event of arrivals) Effect.runSync(views.arrive(event));
    const asked = record(views, events.project, conflictId);
    const rulings = [
      events.of(escalation, {
        _tag: "RulingGiven",
        escalationId,
        option: "effect-stands",
        by: "user:usr_1",
      } as { _tag: string }),
      events.of({ kind: "decision", id: decisionId }, {
        _tag: "DecisionRecorded",
        decisionId,
        escalationId,
        option: "effect-stands",
        summary: "The effect stands",
        evidence: [],
        alternatives: [],
      } as { _tag: string }),
      events.of(conflict, {
        _tag: "ConflictResolved",
        conflictId,
        move: "escalate",
        decisionId,
      } as { _tag: string }),
    ];
    for (const event of rulings) Effect.runSync(views.arrive(event));
    const ruled = record(views, events.project, conflictId);

    expect(conflictOk(asked, "members").body).toMatchObject({
      state: "escalated",
      escalation: {
        id: escalationId,
        label: "E-1",
        open: true,
        reason: "human-class",
        question: "Which holds?",
        state: "open",
        options,
        evidence,
      },
    });
    expect(Reflect.get(conflictOk(asked, "public").body, "escalation")).toEqual({
      id: escalationId,
      label: "E-1",
      open: true,
      reason: "human-class",
    });
    const chosen = { id: "effect-stands", label: "The effect stands" };
    expect(conflictOk(ruled, "members").body).toMatchObject({
      state: "resolved",
      move: "escalate",
      escalation: { open: false, state: "ruled" },
      decision: { id: decisionId, label: "D-1", chosen },
    });
    expect(Reflect.get(conflictOk(ruled, "public").body, "decision")).toEqual({
      id: decisionId,
      label: "D-1",
      chosen,
    });
    expect(Reflect.get(conflictOk(ruled, "public").body, "escalation")).toEqual({
      id: escalationId,
      label: "E-1",
      open: false,
      reason: "human-class",
    });
  });
});
