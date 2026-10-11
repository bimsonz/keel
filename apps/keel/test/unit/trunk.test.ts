// The Trunk over in-memory ports: Initialize and promotion through the
// domain's Promotion machine and commit(), and the project repo convention.
// Deliveries are handed to `trunkHeard` as the Trunk DO's receive would; the
// debounce and push deadlines run `flushTrunk` and `pushPromotion`.
import { describe, expect, it } from "@effect/vitest";
import {
  flushTrunk,
  initializeTrunk,
  mainLane,
  projectRepos,
  pushPromotion,
  resumeTrunk,
  syncTrunk,
  trunkHeard,
  trunkOf,
} from "@keeltown/core/application/integration";
import {
  type BatchId,
  type CandidateId,
  type ChangeId,
  CommitSha,
  EventEnvelope,
  Instant,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { CodeHost, EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  makeClockMemory,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeManualClock,
  makeTrunkWriterMemory,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { ulid } from "ulid";

const PROJECT: ProjectId = makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));

const ports = () => Layer.mergeAll(makeEventOutboxMemory().layer, makeClockMemory().layer);

const logOf = (projectId: ProjectId) =>
  Effect.map(EventOutbox, (outbox) =>
    outbox.log({ kind: "trunk", id: projectId }).map((e) => e.type),
  );

describe("the Trunk's Initialize", () => {
  it.effect(
    "[trunk.init] commits TrunkInitialized once and leaves trunk idle at the head; a retry answers the same trunk",
    () =>
      Effect.gen(function* () {
        const first = yield* initializeTrunk(PROJECT, sha("a"), "seed");
        expect(first).toMatchObject({ projectId: PROJECT, phase: "idle", head: sha("a") });
        expect(trunkOf(yield* EntityStore, PROJECT)).toEqual(first);
        const again = yield* initializeTrunk(PROJECT, sha("a"), "seed");
        expect(again).toEqual(first);
        expect(yield* logOf(PROJECT)).toEqual(["TrunkInitialized"]);
      }).pipe(Effect.provide(ports())),
  );

  it.effect("[trunk.project] TrunkInitialized carries the trunk's project", () =>
    Effect.gen(function* () {
      yield* initializeTrunk(PROJECT, sha("a"), "seed");
      const log = (yield* EventOutbox).log({ kind: "trunk", id: PROJECT });
      expect(log.map((e) => [e.type, e.project])).toEqual([["TrunkInitialized", PROJECT]]);
    }).pipe(Effect.provide(ports())),
  );

  it.effect(
    "[trunk.init-once] another head is PromotionStateRefused and trunk keeps its first head",
    () =>
      Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed");
        const refused = yield* Effect.flip(initializeTrunk(PROJECT, sha("b"), "operator"));
        expect(refused).toMatchObject({ _tag: "PromotionStateRefused", command: "Initialize" });
        expect(trunkOf(yield* EntityStore, PROJECT)?.head).toBe(sha("a"));
        expect(yield* logOf(PROJECT)).toEqual(["TrunkInitialized"]);
      }).pipe(Effect.provide(ports())),
  );
});

describe("the Trunk's sync", () => {
  it.effect(
    "[trunk.sync] copies trunk's head into staging and the mirror, and a second sync changes nothing",
    () => {
      const writer = makeTrunkWriterMemory(sha("c"));
      const repos = projectRepos(PROJECT);
      return Effect.gen(function* () {
        expect(yield* syncTrunk(PROJECT)).toEqual({
          head: sha("c"),
          staging: "advanced",
          mirror: "advanced",
        });
        expect([writer.synced(repos.staging), writer.synced(repos.mirror)]).toEqual([
          sha("c"),
          sha("c"),
        ]);
        expect(writer.synced(repos.trunk)).toBeUndefined();
        expect(yield* syncTrunk(PROJECT)).toEqual({
          head: sha("c"),
          staging: "unchanged",
          mirror: "unchanged",
        });
      }).pipe(Effect.provide(writer.layer));
    },
  );
});

describe("projectRepos", () => {
  it("[repos.distinct] gives each project its own trunk, staging and mirror, as valid repo names", () => {
    const one = projectRepos(PROJECT);
    const other = projectRepos(makeId("prj", "01J9YYYYYYYYYYYYYYYYYYYYYY"));
    expect([one.trunk.namespace, one.staging.namespace, one.mirror.namespace]).toEqual([
      "keel-core",
      "keel-core",
      "keel-ws-00",
    ]);
    const names = [one, other].flatMap((r) => [r.trunk.name, r.staging.name, r.mirror.name]);
    expect(new Set(names).size).toBe(6);
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

const STAGING = projectRepos(PROJECT).staging;
const MAIN = "refs/heads/main";
const LANE = mainLane(PROJECT);
const TRUNK = { kind: "trunk" as const, id: PROJECT };
const change = (n: number): ChangeId => makeId("chg", `01J9C${String(n).padStart(21, "0")}`);
const batch = (n: number): BatchId => makeId("bat", `01J9B${String(n).padStart(21, "0")}`);
const candidate = (n: number): CandidateId => makeId("cnd", `01J9D${String(n).padStart(21, "0")}`);

/** Trunk, staging and the outbox in memory; trunk's writer starts wherever `seeded` initializes it. */
function promotion() {
  const code = makeCodeHostMemory();
  const outbox = makeEventOutboxMemory();
  const clock = makeManualClock();
  const writer = makeTrunkWriterMemory(sha("0"));
  const layer = Layer.mergeAll(code.layer, outbox.layer, clock.layer, writer.layer);
  const stagingRefs = () => code.repos.get(`${STAGING.namespace}/${STAGING.name}`)?.refs;
  /** Staging and trunk at one base commit, trunk initialized there. */
  const seeded = Effect.gen(function* () {
    (yield* EventOutbox).subscribe("projector", "*");
    yield* (yield* CodeHost).create(STAGING);
    const base = yield* code.fixture.commit(STAGING, MAIN, { "README.md": "keel\n" });
    writer.interfere(base);
    yield* initializeTrunk(PROJECT, base, "seed");
    return base;
  });
  /** Candidate `n`, composed on `base` at refs/heads/cand/<cid> in staging, adding its own file. */
  const composed = (n: number, base: CommitSha) =>
    Effect.gen(function* () {
      const ref = `refs/heads/cand/${candidate(n)}`;
      stagingRefs()?.set(ref, base);
      return yield* code.fixture.commit(STAGING, ref, {
        "README.md": "keel\n",
        [`src/change-${n}.ts`]: `export const n = ${n};\n`,
      });
    });
  return { code, clock, writer, layer, seeded, composed };
}

let delivered = 0;
/** Batch `n`'s BatchVerified as the Lane committed it: a batch of one, change `n`, on `base`. */
const verified = (n: number, base: CommitSha) => {
  delivered += 1;
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: `evt_${ulid()}`,
    type: "BatchVerified",
    entity: { kind: "batch", id: batch(n) },
    seq: delivered,
    at: 0,
    dedupeKey: `batch:${batch(n)}/verdict-${n}/BatchVerified#1`,
    affected: [{ kind: "change", id: change(n) }],
    notified: [`trunk:${PROJECT}`],
    payload: {
      _tag: "BatchVerified",
      batchId: batch(n),
      candidateId: candidate(n),
      verdictId: makeId("vrd", ulid()),
      members: [change(n)],
      base,
    },
  });
};

/** Delivers an event to trunk as the Trunk DO's receive does: recorded and reacted to in one transaction. */
const deliver = (event: EventEnvelope) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    const at = Instant(0);
    return store.transaction(
      () =>
        outbox.receive(event.dedupeKey, at) && trunkHeard({ store, outbox, at }, PROJECT, event),
    );
  });

/** Trunk's own events, in commit order, with who each was owed to. */
const trunkLog = Effect.map(EventOutbox, (outbox) => outbox.log(TRUNK));
const typesOf = Effect.map(trunkLog, (log) => log.map((e) => e.type));

/** A field of an event's payload, as committed. */
const fieldOf = (e: EventEnvelope, field: string): unknown =>
  typeof e.payload === "object" && e.payload !== null && field in e.payload
    ? Reflect.get(e.payload, field)
    : undefined;

describe("the Trunk's promotion", () => {
  it.effect(
    "[trunk.promote-as-is] a batch verified on trunk's head lands as its candidate's commit, read back, with each member's landing",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const tip = yield* w.composed(1, base);
        expect(yield* deliver(verified(1, base))).toBe(true);
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.pushes()).toEqual([{ from: base, to: tip }]);
        expect(w.writer.head()).toBe(tip);
        const log = yield* trunkLog;
        expect(log.map((e) => e.type)).toEqual([
          "TrunkInitialized",
          "PromotionStarted",
          "PromotionComposed",
          "TrunkAdvanced",
        ]);
        expect(log.at(-1)?.payload).toMatchObject({
          from: base,
          to: tip,
          landings: [
            {
              changeId: change(1),
              commitSha: tip,
              candidateId: candidate(1),
              proofId: expect.any(String),
            },
          ],
          height: 1,
        });
        expect(trunkOf(yield* EntityStore, PROJECT)).toMatchObject({ phase: "idle", head: tip });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.before-init] a BatchVerified for a trunk not yet initialized is refused and queues nothing",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        expect(yield* deliver(verified(1, sha("a")))).toBe(false);
        expect(trunkOf(yield* EntityStore, PROJECT)).toBeUndefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.subscribes] the member's Change DO and the lane hear the TrunkAdvanced that lands it, and the lane every decline",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* w.composed(1, base);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        yield* pushPromotion(PROJECT);
        // Batch 2 was verified on the head batch 1 replaced: trunk declines it.
        yield* w.composed(2, base);
        yield* deliver(verified(2, base));
        yield* flushTrunk(PROJECT);
        const log = yield* trunkLog;
        const advanced = log.find((e) => e.type === "TrunkAdvanced");
        expect(advanced?.affected).toEqual([{ kind: "change", id: change(1) }]);
        expect(advanced?.notified).toEqual(expect.arrayContaining([`change:${change(1)}`, LANE]));
        expect(advanced?.notified).not.toContain(`change:${change(2)}`);
        const declined = log.find((e) => e.type === "PromotionDeclined");
        expect(declined?.notified).toEqual(expect.arrayContaining([LANE]));
        expect(declined?.affected).toEqual([{ kind: "change", id: change(2) }]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.declines-moved-head] a batch verified on a head trunk has moved past is declined for re-verification and never pushed",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const first = yield* w.composed(1, base);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        yield* pushPromotion(PROJECT);
        yield* w.composed(2, base);
        yield* deliver(verified(2, base));
        expect(yield* flushTrunk(PROJECT)).toBe("idle");
        expect(w.writer.pushes()).toEqual([{ from: base, to: first }]);
        expect((yield* trunkLog).at(-1)?.payload).toEqual({
          _tag: "PromotionDeclined",
          projectId: PROJECT,
          batchId: batch(2),
          reason: "commutation-failed",
          reverify: [change(2)],
        });
        expect(trunkOf(yield* EntityStore, PROJECT)?.head).toBe(first);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.freeze-stale] a head trunk does not know freezes promotion, at the flush or at the read-back, and nothing more is pushed",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const tip = yield* w.composed(1, base);
        yield* deliver(verified(1, base));
        // Someone moved trunk between the WAL entry and the push.
        yield* flushTrunk(PROJECT);
        w.writer.interfere(sha("f"));
        expect(yield* pushPromotion(PROJECT)).toBe("frozen");
        expect((yield* trunkLog).at(-1)?.payload).toMatchObject({
          _tag: "PromotionFrozen",
          expected: tip,
          observed: sha("f"),
        });
        expect(yield* pushPromotion(PROJECT)).toBe("frozen");
        expect(w.writer.pushes()).toEqual([{ from: base, to: tip }]);

        // And before the flush: trunk is not where the trunk DO knows it is.
        const v = promotion();
        const vBase = yield* v.seeded.pipe(Effect.provide(v.layer));
        yield* v.composed(1, vBase).pipe(Effect.provide(v.layer));
        v.writer.interfere(sha("e"));
        yield* deliver(verified(1, vBase)).pipe(Effect.provide(v.layer));
        expect(yield* flushTrunk(PROJECT).pipe(Effect.provide(v.layer))).toBe("frozen");
        expect(yield* pushPromotion(PROJECT).pipe(Effect.provide(v.layer))).toBe("frozen");
        expect(v.writer.pushes()).toEqual([]);
        expect((yield* trunkLog.pipe(Effect.provide(v.layer))).at(-1)?.payload).toMatchObject({
          _tag: "PromotionFrozen",
          expected: vBase,
          observed: sha("e"),
        });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.retry-same-sha] a push trunk did not take is pushed again with the recorded SHA, never recomposed",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const tip = yield* w.composed(1, base);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        w.writer.drop(1);
        expect(yield* pushPromotion(PROJECT)).toBe("retry");
        expect(trunkOf(yield* EntityStore, PROJECT)?.phase).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.pushes()).toEqual([
          { from: base, to: tip },
          { from: base, to: tip },
        ]);
        expect((yield* typesOf).filter((t) => t === "PromotionComposed")).toHaveLength(1);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.resume] an operator's resume releases a freeze at trunk's head as it reads now, and the next batch on it lands",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        yield* w.composed(1, base);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        // Someone else's commit reached trunk: the push of batch 1 freezes.
        const moved = yield* w.composed(9, base);
        w.writer.interfere(moved);
        expect(yield* pushPromotion(PROJECT)).toBe("frozen");
        const resumed = yield* resumeTrunk(PROJECT, "operator:zach");
        expect(resumed).toMatchObject({ phase: "idle", head: moved });
        expect((yield* typesOf).slice(-2)).toEqual(["PromotionDeclined", "PromotionResumed"]);
        const tip = yield* w.composed(2, moved);
        yield* deliver(verified(2, moved));
        w.clock.advance(1);
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.head()).toBe(tip);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.racers] ten batches on one head, each delivered twice and interleaved with the promotion: one lands, nine are declined, none twice",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const tips: CommitSha[] = [];
        for (let n = 1; n <= 10; n++) tips.push(yield* w.composed(n, base));
        const deliveries = Array.from({ length: 10 }, (_, i) => i + 1).flatMap((n) => [
          verified(n, base),
          verified(n, base),
        ]);
        // The promotion runs between deliveries, as the debounce and push deadlines would.
        const drive = Effect.gen(function* () {
          for (let i = 0; i < 200; i++) {
            w.clock.advance(1);
            yield* flushTrunk(PROJECT);
            yield* pushPromotion(PROJECT);
            yield* Effect.yieldNow;
          }
        });
        const heard = yield* Effect.all(
          [
            Effect.forEach(deliveries, (event) =>
              deliver(event).pipe(Effect.tap(() => Effect.yieldNow)),
            ),
            drive,
          ],
          { concurrency: "unbounded" },
        );
        expect(heard[0].filter(Boolean)).toHaveLength(10);
        const log = yield* trunkLog;
        const ofType = (type: string) => log.filter((e) => e.type === type);
        expect(ofType("TrunkAdvanced")).toHaveLength(1);
        expect(ofType("PromotionDeclined")).toHaveLength(9);
        expect(ofType("PromotionFrozen")).toHaveLength(0);
        const started = ofType("PromotionStarted").flatMap((e) => {
          const batches = fieldOf(e, "batches");
          return Array.isArray(batches) ? batches.map(String) : [];
        });
        const fates = [
          ...started,
          ...ofType("PromotionDeclined").map((e) => String(fieldOf(e, "batchId"))),
        ];
        expect(fates.toSorted()).toEqual(
          Array.from({ length: 10 }, (_, i) => batch(i + 1)).toSorted(),
        );
        expect(w.writer.pushes()).toHaveLength(1);
        expect(w.writer.head()).toBe(tips[0]);
        expect(trunkOf(yield* EntityStore, PROJECT)).toMatchObject({ phase: "idle", queue: [] });
      }).pipe(Effect.provide(w.layer));
    },
  );
});
