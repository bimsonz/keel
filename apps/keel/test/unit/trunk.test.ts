// The Trunk over in-memory ports: Initialize and promotion through the
// domain's Promotion machine and commit(), and the project repo convention.
// Deliveries are handed to `trunkHeard` as the Trunk DO's receive would; the
// debounce and push deadlines run `flushTrunk` and `pushPromotion`.
import { describe, expect, it } from "@effect/vitest";
import {
  adoptTrunk,
  deleteProjectRepos,
  destroyTrunk,
  flushTrunk,
  initializeTrunk,
  mainLane,
  projectRepos,
  pushPromotion,
  resumeTrunk,
  seedTrunk,
  syncMirror,
  syncTrunk,
  trunkDestroyed,
  trunkHeard,
  trunkOf,
  trunkStanding,
} from "@keeltown/core/application/integration";
import {
  type BatchId,
  type CandidateId,
  type ChangeId,
  CommitSha,
  EventEnvelope,
  Instant,
  makeId,
  type NamespaceId,
  type ProjectId,
  userActor,
} from "@keeltown/core/kernel";
import { DEFAULT_QUOTAS } from "@keeltown/core/domain/identity";
import type { TrunkOrigin } from "@keeltown/core/domain/integration";
import {
  Clock,
  CodeHost,
  EntityStore,
  EventOutbox,
  OrgUsage,
  RELAY_PACK_CAP_BYTES,
} from "@keeltown/core/ports";
import {
  makeClockMemory,
  makeCodeHostMemory,
  makeEventOutboxMemory,
  makeManualClock,
  makeOrgUsageMemory,
  makeProjectNamespacesMemory,
  makeTrunkWriterMemory,
  MEMORY_SEED,
} from "@keeltown/testing";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import * as fc from "fast-check";
import { ulid } from "ulid";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 50, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const PROJECT: ProjectId = makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
/** Whoever releases a freeze: a person, as a command names one. */
const RELEASER = userActor(makeId("usr", "01J9ZZZZZZZZZZZZZZZZZZZZZZ"));
const ORG: NamespaceId = makeId("org", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
/** An empty project's origin: the start that names no commit, for cases that are not about where trunk started. */
const EMPTY: TrunkOrigin = { kind: "empty" };

/** Puts the project in ORG, as creating it does before its trunk exists: its trunk is weighed, and counted into ORG's repo bytes. */
const place = (places: ReturnType<typeof makeProjectNamespacesMemory>) =>
  places.places.set(PROJECT, { projectId: PROJECT, namespace: ORG, name: "keel" });

/** Takes the project's place away, which nothing in Keel does: what its trunk then does is the defect's own test. */
const unplace = (places: ReturnType<typeof makeProjectNamespacesMemory>) =>
  places.places.delete(PROJECT);

/** What a program that died said, or undefined for one that did not die. */
const defectOf = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(program), (exit) =>
    Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.pretty(exit.cause) : undefined,
  );

/** The outbox and a clock, a trunk writer at `a`, and the project placed in ORG. */
const ports = () => {
  const places = makeProjectNamespacesMemory();
  place(places);
  const writer = makeTrunkWriterMemory(sha("a"));
  return {
    places,
    writer,
    layer: Layer.mergeAll(
      makeEventOutboxMemory().layer,
      makeClockMemory().layer,
      places.layer,
      makeOrgUsageMemory().layer,
      writer.layer,
    ),
  };
};

/** ORG's repo bytes as counted now: what an admission of nothing finds used. */
const counted = Effect.map(
  Effect.flatMap(OrgUsage, (usage) => usage.admit(ORG, "repo-bytes", 0, `probe-${ulid()}`)),
  (answer) => answer.limit - answer.remaining,
);

const logOf = (projectId: ProjectId) =>
  Effect.map(EventOutbox, (outbox) =>
    outbox.log({ kind: "trunk", id: projectId }).map((e) => e.type),
  );

describe("the Trunk's Initialize", () => {
  it.effect(
    "[trunk.init] commits TrunkInitialized once and leaves trunk idle at the head; a retry answers the same trunk",
    () =>
      Effect.gen(function* () {
        const first = yield* initializeTrunk(PROJECT, sha("a"), "seed", EMPTY);
        expect(first).toMatchObject({ projectId: PROJECT, phase: "idle", head: sha("a") });
        expect(trunkOf(yield* EntityStore, PROJECT)).toEqual(first);
        const again = yield* initializeTrunk(PROJECT, sha("a"), "seed", EMPTY);
        expect(again).toEqual(first);
        expect(yield* logOf(PROJECT)).toEqual(["TrunkInitialized"]);
      }).pipe(Effect.provide(ports().layer)),
  );

  it.effect("[trunk.project] TrunkInitialized carries the trunk's project", () =>
    Effect.gen(function* () {
      yield* initializeTrunk(PROJECT, sha("a"), "seed", EMPTY);
      const log = (yield* EventOutbox).log({ kind: "trunk", id: PROJECT });
      expect(log.map((e) => [e.type, e.project])).toEqual([["TrunkInitialized", PROJECT]]);
    }).pipe(Effect.provide(ports().layer)),
  );

  it.effect(
    "[trunk.init-once] another head is PromotionStateRefused and trunk keeps its first head",
    () =>
      Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", EMPTY);
        const refused = yield* Effect.flip(initializeTrunk(PROJECT, sha("b"), "operator", EMPTY));
        expect(refused).toMatchObject({ _tag: "PromotionStateRefused", command: "Initialize" });
        expect(trunkOf(yield* EntityStore, PROJECT)?.head).toBe(sha("a"));
        expect(yield* logOf(PROJECT)).toEqual(["TrunkInitialized"]);
      }).pipe(Effect.provide(ports().layer)),
  );
});

describe("the Trunk's origin", () => {
  const ORIGINS: readonly TrunkOrigin[] = [
    EMPTY,
    {
      kind: "imported",
      url: "https://git.example/team/app",
      ref: "refs/heads/master",
      commit: sha("a"),
    },
    { kind: "forked", project: makeId("prj", "01J9YYYYYYYYYYYYYYYYYYYYYY"), commit: sha("a") },
    { kind: "template", name: "starter", commit: sha("a") },
  ];

  for (const origin of ORIGINS)
    it.effect(
      `[trunk.origin] TrunkInitialized says where trunk started (${origin.kind}), the trunk keeps it, and a retry that names another start changes neither`,
      () =>
        Effect.gen(function* () {
          const first = yield* initializeTrunk(PROJECT, sha("a"), "seed", origin);
          expect(first.origin).toEqual(origin);
          const again = yield* initializeTrunk(PROJECT, sha("a"), "seed", {
            kind: "template",
            name: "another",
            commit: sha("a"),
          });
          expect(again).toEqual(first);
          expect(trunkOf(yield* EntityStore, PROJECT)?.origin).toEqual(origin);
          const log = (yield* EventOutbox).log({ kind: "trunk", id: PROJECT });
          expect(log.map((e) => e.payload)).toEqual([
            { _tag: "TrunkInitialized", projectId: PROJECT, head: sha("a"), by: "seed", origin },
          ]);
        }).pipe(Effect.provide(ports().layer)),
    );

  for (const origin of ORIGINS.filter((o) => o.kind !== "empty"))
    it.effect(
      `[trunk.origin-head] an origin (${origin.kind}) that names another commit than trunk's first head is a defect: no trunk, no event, nothing counted`,
      () => {
        const w = ports();
        w.writer.holds(sha("b"), 4_000);
        return Effect.gen(function* () {
          const said = yield* defectOf(initializeTrunk(PROJECT, sha("b"), "seed", origin));
          expect(said ?? "no defect").toContain(
            `trunk ${PROJECT} starts at ${sha("b")}, and its origin names ${sha("a")}`,
          );
          expect(trunkOf(yield* EntityStore, PROJECT)).toBeUndefined();
          expect(yield* logOf(PROJECT)).toEqual([]);
          expect(yield* counted).toBe(0);
        }).pipe(Effect.provide(w.layer));
      },
    );
});

/** ORG's repo bytes are `limit` from here on. */
const allow = (limit: number) =>
  Effect.flatMap(OrgUsage, (usage) =>
    usage.configure(ORG, { overrides: { "repo-bytes": limit }, halted: false }),
  );

describe("the Trunk's admission of an import", () => {
  const IMPORTED: TrunkOrigin = {
    kind: "imported",
    url: "https://git.example/team/app",
    ref: "refs/heads/master",
    commit: sha("a"),
  };
  it.effect(
    "[trunk.import-admitted] an imported history that fits what its namespace has left is admitted and counted once, however often trunk is initialized",
    () => {
      const w = ports();
      w.writer.holds(sha("a"), 4_000);
      return Effect.gen(function* () {
        yield* allow(4_000);
        const first = yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
        expect(first.origin).toEqual(IMPORTED);
        expect(yield* counted).toBe(4_000);
        expect(yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED)).toEqual(first);
        expect(yield* counted).toBe(4_000);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.import-over-quota] an imported history over what its namespace has left is QuotaExceeded: trunk gets no head, no event is committed and nothing is counted",
    () => {
      const w = ports();
      w.writer.holds(sha("a"), 4_000);
      return Effect.gen(function* () {
        yield* allow(3_999);
        const refused = yield* Effect.flip(initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED));
        expect(refused).toMatchObject({
          _tag: "QuotaExceeded",
          kind: "repo-bytes",
          limit: 3_999,
          used: 0,
          requested: 4_000,
        });
        expect(trunkOf(yield* EntityStore, PROJECT)).toBeUndefined();
        expect(yield* logOf(PROJECT)).toEqual([]);
        expect(yield* counted).toBe(0);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.start-counted] a start that is not an import is counted and never refused: a template's history over what its namespace has left still gives trunk its head",
    () => {
      const w = ports();
      w.writer.holds(sha("a"), 4_000);
      return Effect.gen(function* () {
        yield* allow(3_999);
        const trunk = yield* initializeTrunk(PROJECT, sha("a"), "seed", {
          kind: "template",
          name: "starter",
          commit: sha("a"),
        });
        expect(trunk).toMatchObject({ phase: "idle", head: sha("a") });
        yield* allow(10_000);
        expect(yield* counted).toBe(4_000);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.import-over-cap] an imported history one byte over what a relay carries is ImportTooLarge, with its size and the limit: trunk gets no head and nothing is counted; one of exactly the limit is admitted",
    () => {
      const w = ports();
      return Effect.gen(function* () {
        yield* allow(2 * RELAY_PACK_CAP_BYTES);
        w.writer.holds(sha("a"), RELAY_PACK_CAP_BYTES + 1);
        const refused = yield* Effect.flip(initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED));
        expect(refused).toMatchObject({
          _tag: "ImportTooLarge",
          projectId: PROJECT,
          bytes: RELAY_PACK_CAP_BYTES + 1,
          limit: RELAY_PACK_CAP_BYTES,
        });
        expect(trunkOf(yield* EntityStore, PROJECT)).toBeUndefined();
        expect(yield* logOf(PROJECT)).toEqual([]);
        expect(yield* counted).toBe(0);

        w.writer.holds(sha("a"), RELAY_PACK_CAP_BYTES);
        yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
        expect(yield* counted).toBe(RELAY_PACK_CAP_BYTES);
      }).pipe(Effect.provide(w.layer));
    },
  );
});

describe("the Trunk's first write", () => {
  it.effect(
    "[trunk.adopt] before trunk has a head the writer makes main at the commit named; once it is initialized the ask is a defect and the writer is not reached",
    () => {
      const w = ports();
      return Effect.gen(function* () {
        yield* adoptTrunk(PROJECT, sha("b"));
        expect(w.writer.adopted()).toEqual([sha("b")]);
        yield* initializeTrunk(PROJECT, sha("b"), "seed", EMPTY);
        const said = yield* defectOf(adoptTrunk(PROJECT, sha("c")));
        expect(said ?? "no defect").toContain(`trunk ${PROJECT} is initialized: adopt`);
        expect(w.writer.adopted()).toEqual([sha("b")]);
        expect(w.writer.head()).toBe(sha("b"));
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.seed] before trunk has a head the writer is asked for the first commit with the name and the time given, and it is answered; once it is initialized the ask is a defect and the writer is not reached",
    () => {
      const w = ports();
      const at = Instant(1_760_000_000_000);
      return Effect.gen(function* () {
        expect(yield* seedTrunk(PROJECT, "keel", at)).toBe(MEMORY_SEED);
        expect(w.writer.seeds()).toEqual([{ name: "keel", at }]);
        yield* initializeTrunk(PROJECT, MEMORY_SEED, "seed", EMPTY);
        const said = yield* defectOf(seedTrunk(PROJECT, "other", Instant(1)));
        expect(said ?? "no defect").toContain(`trunk ${PROJECT} is initialized: seed`);
        expect(w.writer.seeds()).toEqual([{ name: "keel", at }]);
      }).pipe(Effect.provide(w.layer));
    },
  );
});

describe("the Trunk's count at create", () => {
  it.effect(
    "[trunk.create-counted] a project's whole history at its first head is counted into its org once, however often it is initialized",
    () => {
      const w = ports();
      w.writer.holds(sha("a"), 4_000);
      return Effect.gen(function* () {
        expect(yield* counted).toBe(0);
        yield* initializeTrunk(PROJECT, sha("a"), "seed", EMPTY);
        expect(yield* counted).toBe(4_000);
        yield* initializeTrunk(PROJECT, sha("a"), "seed", EMPTY);
        yield* Effect.flip(initializeTrunk(PROJECT, sha("b"), "operator", EMPTY));
        expect(yield* counted).toBe(4_000);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.no-org-init] a project with no place is a defect that names it: it is given no trunk, and nothing is counted",
    () => {
      const w = ports();
      unplace(w.places);
      w.writer.holds(sha("a"), 4_000);
      return Effect.gen(function* () {
        const said = yield* defectOf(initializeTrunk(PROJECT, sha("a"), "seed", EMPTY));
        expect(said ?? "no defect").toContain(`project ${PROJECT} has no place`);
        expect(trunkOf(yield* EntityStore, PROJECT)).toBeUndefined();
        expect(yield* logOf(PROJECT)).toEqual([]);
        expect(yield* counted).toBe(0);
      }).pipe(Effect.provide(w.layer));
    },
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
  const places = makeProjectNamespacesMemory();
  place(places);
  const usage = makeOrgUsageMemory();
  /** Everything but the trunk's writer, for a test that wraps the writer. */
  const rest = Layer.mergeAll(code.layer, outbox.layer, clock.layer, places.layer, usage.layer);
  const layer = Layer.merge(rest, writer.layer);
  const stagingRefs = () => code.repos.get(`${STAGING.namespace}/${STAGING.name}`)?.refs;
  /** Staging and trunk at one base commit, trunk initialized there. */
  const seeded = Effect.gen(function* () {
    (yield* EventOutbox).subscribe("projector", "*");
    yield* (yield* CodeHost).create(STAGING);
    const base = yield* code.fixture.commit(STAGING, MAIN, { "README.md": "keel\n" });
    writer.interfere(base);
    yield* initializeTrunk(PROJECT, base, "seed", EMPTY);
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
  return { code, clock, writer, places, rest, layer, seeded, composed };
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
    "[trunk.reoffer-held] a batch the lane re-offers while trunk holds it, and again once it landed, is still one promotion",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const tip = yield* w.composed(1, base);
        const offer = verified(1, base);
        const again = (n: number) => ({ ...offer, dedupeKey: `${offer.dedupeKey}#reoffer-${n}` });
        expect(yield* deliver(offer)).toBe(true);
        expect(yield* deliver(again(1))).toBe(false);
        expect(trunkOf(yield* EntityStore, PROJECT)?.queue).toHaveLength(1);
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* deliver(again(2))).toBe(false);
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        // Its TrunkAdvanced is still on the way to the lane, which re-offers once more.
        yield* deliver(again(3));
        expect(trunkOf(yield* EntityStore, PROJECT)).toMatchObject({
          phase: "idle",
          head: tip,
          queue: [],
        });
        expect(w.writer.pushes()).toEqual([{ from: base, to: tip }]);
        expect((yield* typesOf).filter((type) => type === "TrunkAdvanced")).toHaveLength(1);
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
    "[trunk.refused-too-large] a group whose pack is over the cap is refused, not left open: its batch is declined with the reason, trunk does not move, and the batch behind it lands",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const big = yield* w.composed(1, base);
        const next = yield* w.composed(2, base);
        w.writer.weigh(big, 61 * 1024 * 1024);
        yield* deliver(verified(1, base));
        yield* deliver(verified(2, base));
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("declined");
        expect(w.writer.head()).toBe(base);
        const declined = (yield* trunkLog).filter((e) => e.type === "PromotionDeclined");
        expect(declined.map((e) => e.payload)).toMatchObject([
          { batchId: batch(1), reason: "pack-too-large", reverify: [] },
        ]);
        expect((yield* typesOf).filter((t) => t === "PromotionFrozen")).toEqual([]);
        // Nothing is left open, so the batch behind it is not held up.
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.head()).toBe(next);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.too-large-moved] a pack over the cap on a trunk that is no longer on the WAL's old head is not a refusal: the read-back decides, and freezes",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const big = yield* w.composed(1, base);
        w.writer.weigh(big, 61 * 1024 * 1024);
        yield* deliver(verified(1, base));
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        w.writer.interfere(sha("f"));
        expect(yield* pushPromotion(PROJECT)).toBe("frozen");
        const types = yield* typesOf;
        expect(types).toContain("PromotionFrozen");
        expect(types).not.toContain("PromotionDeclined");
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.no-org] a project with no place is a defect that names it, on every pass: its group is neither weighed, pushed nor counted, and stays open",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const held = yield* counted;
        const tip = yield* w.composed(1, base);
        w.writer.weigh(tip, 1_032);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        unplace(w.places);
        for (const pass of [1, 2]) {
          const said = yield* defectOf(pushPromotion(PROJECT));
          expect([pass, said]).toEqual([
            pass,
            expect.stringContaining(`project ${PROJECT} has no place`),
          ]);
        }
        expect(w.writer.head()).toBe(base);
        expect(w.writer.pushes()).toEqual([]);
        expect(w.writer.weighed()).toEqual([]);
        expect(yield* counted).toBe(held);
        expect(trunkOf(yield* EntityStore, PROJECT)).toMatchObject({
          phase: "promoting",
          head: base,
        });
        // Its place given back, the same group lands and is counted once.
        place(w.places);
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.head()).toBe(tip);
        expect(yield* counted).toBe(held + 1_000);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.admits-once] a landing is counted into its org as its pack less a pack's 32 bytes, once, however many times the group is pushed",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        // What the create counted: the history at the base.
        const held = yield* counted;
        const tip = yield* w.composed(1, base);
        w.writer.weigh(tip, 1_032);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        w.writer.drop(1);
        expect(yield* pushPromotion(PROJECT)).toBe("retry");
        expect(yield* counted).toBe(held + 1_000);
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(yield* pushPromotion(PROJECT)).toBe("idle");
        expect(w.writer.pushes()).toEqual([
          { from: base, to: tip },
          { from: base, to: tip },
        ]);
        expect(yield* counted).toBe(held + 1_000);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.push-weighs-once] a promotion asks its writer for the push alone: the pack is weighed by the push that sends it, never fetched apart",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const held = yield* counted;
        const tip = yield* w.composed(1, base);
        w.writer.weigh(tip, 1_032);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.weighed()).toEqual([]);
        expect(w.writer.pushes()).toEqual([{ from: base, to: tip }]);
        expect(yield* counted).toBe(held + 1_000);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.refused-quota] a pack over what is left of its org's repo bytes is never pushed: its batch is declined with the reason, nothing is counted, and a smaller batch behind it lands",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        // What the create counted: the history at the base.
        const held = yield* counted;
        const big = yield* w.composed(1, base);
        const next = yield* w.composed(2, base);
        yield* (yield* OrgUsage).configure(ORG, {
          overrides: { "repo-bytes": held + 500 },
          halted: false,
        });
        w.writer.weigh(big, 533);
        w.writer.weigh(next, 532);
        yield* deliver(verified(1, base));
        yield* deliver(verified(2, base));
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("declined");
        expect(w.writer.pushes()).toEqual([]);
        expect(w.writer.head()).toBe(base);
        const declined = (yield* trunkLog).filter((e) => e.type === "PromotionDeclined");
        expect(declined.map((e) => e.payload)).toMatchObject([
          { batchId: batch(1), reason: "repo-bytes-quota", reverify: [] },
        ]);
        expect((yield* typesOf).filter((t) => t === "PromotionFrozen")).toEqual([]);
        expect(yield* counted).toBe(held);
        // The batch behind it fits exactly: 532 bytes of pack are 500 in the repo.
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.head()).toBe(next);
        expect(yield* counted).toBe(held + 500);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.gives-back-frozen] resuming a frozen trunk gives the stopped group's bytes back, unless trunk stands on the group's own commit",
    () =>
      Effect.gen(function* () {
        // Admitted, then trunk moved under the push: frozen with the pack counted, and the resume gives it back.
        const moved = promotion();
        yield* Effect.gen(function* () {
          const base = yield* moved.seeded;
          // What the create counted: the history at the base.
          const held = yield* counted;
          const tip = yield* moved.composed(1, base);
          moved.writer.weigh(tip, 1_032);
          yield* deliver(verified(1, base));
          yield* flushTrunk(PROJECT);
          moved.writer.interfere(sha("f"));
          expect(yield* pushPromotion(PROJECT)).toBe("frozen");
          expect(yield* counted).toBe(held + 1_000);
          yield* resumeTrunk(PROJECT, RELEASER);
          expect(yield* counted).toBe(held);
          yield* resumeTrunk(PROJECT, RELEASER);
          expect(yield* counted).toBe(held);
        }).pipe(Effect.provide(moved.layer));

        // The operator put trunk on the group's own commit: it landed, so its bytes stay counted.
        const landed = promotion();
        yield* Effect.gen(function* () {
          const base = yield* landed.seeded;
          // What the create counted: the history at the base.
          const held = yield* counted;
          const tip = yield* landed.composed(1, base);
          landed.writer.weigh(tip, 1_032);
          yield* deliver(verified(1, base));
          yield* flushTrunk(PROJECT);
          landed.writer.interfere(sha("f"));
          expect(yield* pushPromotion(PROJECT)).toBe("frozen");
          landed.writer.interfere(tip);
          yield* resumeTrunk(PROJECT, RELEASER);
          expect(yield* counted).toBe(held + 1_000);
        }).pipe(Effect.provide(landed.layer));

        // Frozen before it was ever admitted (over the quota, trunk moved): nothing of it was counted, so nothing is given back.
        const refused = promotion();
        yield* Effect.gen(function* () {
          const base = yield* refused.seeded;
          // What the create counted: the history at the base.
          const held = yield* counted;
          const tip = yield* refused.composed(1, base);
          const usage = yield* OrgUsage;
          yield* usage.configure(ORG, { overrides: { "repo-bytes": held + 500 }, halted: false });
          yield* usage.record(ORG, "repo-bytes", 300, "held already");
          refused.writer.weigh(tip, 533);
          yield* deliver(verified(1, base));
          yield* flushTrunk(PROJECT);
          refused.writer.interfere(sha("f"));
          expect(yield* pushPromotion(PROJECT)).toBe("frozen");
          expect(refused.writer.pushes()).toEqual([]);
          yield* resumeTrunk(PROJECT, RELEASER);
          expect(yield* counted).toBe(held + 300);
        }).pipe(Effect.provide(refused.layer));
      }),
  );

  it("[trunk.meter-sums] after any landings an org's repo bytes are its project's history at create plus each landed pack less 32 bytes", async () => {
    const weights = fc.array(fc.integer({ min: 32, max: 5_000_000 }), {
      minLength: 1,
      maxLength: 6,
    });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 32, max: 5_000_000 }), weights, (history, packs) => {
        const w = promotion();
        return Effect.runPromise(
          Effect.gen(function* () {
            // The harness initializes trunk at its base: weigh that history first.
            (yield* EventOutbox).subscribe("projector", "*");
            yield* (yield* CodeHost).create(STAGING);
            let head = yield* w.code.fixture.commit(STAGING, MAIN, { "README.md": "keel\n" });
            w.writer.interfere(head);
            w.writer.holds(head, history);
            yield* initializeTrunk(PROJECT, head, "seed", EMPTY);
            for (const [i, bytes] of packs.entries()) {
              const tip = yield* w.composed(i + 1, head);
              w.writer.weigh(tip, bytes);
              yield* deliver(verified(i + 1, head));
              yield* flushTrunk(PROJECT);
              expect(yield* pushPromotion(PROJECT)).toBe("advanced");
              head = tip;
            }
            expect(yield* counted).toBe(
              history + packs.reduce((sum, bytes) => sum + bytes - 32, 0),
            );
          }).pipe(Effect.provide(w.layer)),
        );
      }),
    );
    // Well inside the default quota, so no landing above was refused.
    expect(DEFAULT_QUOTAS["repo-bytes"]).toBeGreaterThan(7 * 5_000_000);
    // Fifty runs, each landing up to six packs: seconds in all on a loaded machine, past the default five.
  }, 60_000);

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
    "[trunk.front-only] with several batches queued on trunk's head, a flush starts the front one alone, and the rest wait behind it",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const tip = yield* w.composed(1, base);
        for (const n of [2, 3]) yield* w.composed(n, base);
        for (const n of [1, 2, 3]) yield* deliver(verified(n, base));
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        const started = (yield* trunkLog).filter((e) => e.type === "PromotionStarted");
        expect(started.map((e) => fieldOf(e, "batches"))).toEqual([[batch(1)]]);
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        expect(w.writer.head()).toBe(tip);
        expect(trunkOf(yield* EntityStore, PROJECT)?.queue.map((b) => b.batchId)).toEqual([
          batch(2),
          batch(3),
        ]);
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
        const resumed = yield* resumeTrunk(PROJECT, RELEASER);
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

/** Whether the code host still holds the repo. */
const onHost = (repo: { readonly namespace: string; readonly name: string }) =>
  Effect.flatMap(CodeHost, (host) =>
    host.info(repo).pipe(
      Effect.as(true),
      Effect.catchTag("RepoNotFound", () => Effect.succeed(false)),
    ),
  );
const world = () => Layer.mergeAll(makeCodeHostMemory().layer, ports().layer);

describe("the Trunk's destroy", () => {
  const REPOS = Object.values(projectRepos(PROJECT));
  /** The project's four repos on the host, and its trunk initialized. */
  const project = Effect.gen(function* () {
    const host = yield* CodeHost;
    for (const repo of REPOS) yield* host.create(repo);
    yield* initializeTrunk(PROJECT, sha("a"), "seed", EMPTY);
  });

  it.effect(
    "[trunk.destroy] a destroyed trunk's four repos are deleted and it takes no batch; one that was not destroyed keeps its repos",
    () =>
      Effect.gen(function* () {
        yield* project;
        expect(REPOS).toHaveLength(4);
        // Nothing but a destroy lets the repos go.
        expect(yield* deleteProjectRepos(PROJECT)).toEqual({ deleted: 0, pending: 0 });
        expect(yield* Effect.forEach(REPOS, onHost)).toEqual([true, true, true, true]);
        expect(trunkDestroyed(yield* EntityStore, PROJECT)).toBe(false);

        yield* destroyTrunk(PROJECT, "user:owner");
        yield* destroyTrunk(PROJECT, "user:owner");
        expect(trunkDestroyed(yield* EntityStore, PROJECT)).toBe(true);
        expect(yield* deleteProjectRepos(PROJECT)).toEqual({ deleted: 4, pending: 0 });
        expect(yield* Effect.forEach(REPOS, onHost)).toEqual([false, false, false, false]);
        // A repo already gone counts as deleted: a second pass has nothing pending.
        expect(yield* deleteProjectRepos(PROJECT)).toEqual({ deleted: 4, pending: 0 });

        const before = trunkOf(yield* EntityStore, PROJECT);
        expect(yield* deliver(verified(1, sha("a")))).toBe(false);
        expect(trunkOf(yield* EntityStore, PROJECT)).toEqual(before);
        expect(before).toMatchObject({ phase: "idle", queue: [] });
        // No event of the trunk's says it was destroyed: ProjectDeleted is the Project's to commit.
        expect(yield* logOf(PROJECT)).toEqual(["TrunkInitialized"]);
      }).pipe(Effect.provide(world())),
  );

  it.effect(
    "[trunk.destroy-pending] a repo whose deletion fails stays pending, and the next pass deletes it",
    () => {
      const code = makeCodeHostMemory();
      const mirror = projectRepos(PROJECT).mirror;
      let failures = 2;
      const flaky = Layer.effect(
        CodeHost,
        Effect.gen(function* () {
          const inner = yield* CodeHost;
          return CodeHost.of({
            ...inner,
            delete: (repo) =>
              repo.name === mirror.name && failures > 0
                ? Effect.sync(() => void (failures -= 1)).pipe(
                    Effect.andThen(Effect.die(new Error("the host did not answer"))),
                  )
                : inner.delete(repo),
          });
        }),
      ).pipe(Layer.provide(code.layer));
      return Effect.gen(function* () {
        yield* project;
        yield* destroyTrunk(PROJECT, "user:owner");
        expect(yield* deleteProjectRepos(PROJECT)).toEqual({ deleted: 3, pending: 1 });
        expect(yield* deleteProjectRepos(PROJECT)).toEqual({ deleted: 3, pending: 1 });
        expect(code.repos.has(`${mirror.namespace}/${mirror.name}`)).toBe(true);
        expect(yield* deleteProjectRepos(PROJECT)).toEqual({ deleted: 4, pending: 0 });
        expect(code.repos.size).toBe(0);
      }).pipe(Effect.provide(Layer.mergeAll(flaky, ports().layer)));
    },
  );

  it.effect(
    "[trunk.destroy-stops] a destroyed trunk decides no group, pushes none it had opened, and syncs no mirror",
    () =>
      Effect.gen(function* () {
        // A batch waiting on the debounce when the trunk is destroyed: the flush decides nothing.
        const queued = promotion();
        yield* Effect.gen(function* () {
          const base = yield* queued.seeded;
          yield* queued.composed(1, base);
          expect(yield* deliver(verified(1, base))).toBe(true);
          yield* destroyTrunk(PROJECT, "user:owner");
          expect(yield* flushTrunk(PROJECT)).toBe("debouncing");
          expect(yield* pushPromotion(PROJECT)).toBe("idle");
          expect(yield* typesOf).toEqual(["TrunkInitialized"]);
          expect(queued.writer.pushes()).toEqual([]);
          expect(yield* syncMirror(PROJECT)).toBeUndefined();
          expect(queued.writer.synced(projectRepos(PROJECT).mirror)).toBeUndefined();
        }).pipe(Effect.provide(queued.layer));

        // A group already open, its WAL written, when the trunk is destroyed: it is never pushed.
        const opened = promotion();
        yield* Effect.gen(function* () {
          const base = yield* opened.seeded;
          yield* opened.composed(1, base);
          yield* deliver(verified(1, base));
          expect(yield* flushTrunk(PROJECT)).toBe("promoting");
          yield* destroyTrunk(PROJECT, "user:owner");
          expect(yield* pushPromotion(PROJECT)).toBe("idle");
          expect(opened.writer.pushes()).toEqual([]);
          expect(opened.writer.head()).toBe(base);
          expect(yield* typesOf).toEqual(["TrunkInitialized", "PromotionStarted"]);
        }).pipe(Effect.provide(opened.layer));
      }),
  );
});

/** A clock that never gives one instant twice, as a wall clock may not between two reads. */
const ticking = () => {
  let now = 1_700_000_000_000;
  return Clock.of({
    now: Effect.sync(() => {
      now += 7;
      return Instant(now);
    }),
  });
};

/** A stored trunk as a Trunk DO wrote it before `advancedAt` was kept. */
const beforeItsTime = (stored: unknown) => {
  if (typeof stored !== "object" || stored === null) throw new Error("no trunk is stored");
  return Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "advancedAt"));
};

describe("the Trunk as a reader is shown it", () => {
  it.effect(
    "[trunk.advanced-at.event-time] on a clock that moves between any two reads, trunk's advancedAt is its event's own commit time: TrunkInitialized's, then TrunkAdvanced's",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        const base = yield* w.seeded;
        const initialized = (yield* trunkLog).at(-1);
        expect(initialized?.type).toBe("TrunkInitialized");
        expect(trunkOf(yield* EntityStore, PROJECT)?.advancedAt).toBe(initialized?.at);
        const tip = yield* w.composed(1, base);
        yield* deliver(verified(1, base));
        expect(yield* flushTrunk(PROJECT)).toBe("promoting");
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        const advanced = (yield* trunkLog).at(-1);
        expect(advanced?.type).toBe("TrunkAdvanced");
        expect(advanced?.at).not.toBe(initialized?.at);
        expect(yield* trunkStanding(PROJECT)).toEqual(
          Option.some({ head: tip, phase: "idle", advancedAt: advanced?.at }),
        );
      }).pipe(Effect.provideService(Clock, ticking()), Effect.provide(w.layer));
    },
  );

  it.effect(
    "[trunk.standing] a trunk with no head yet is shown as none; one stored before advancedAt was kept is shown the time of the last event in its log that changed its head: an advance, not the freeze after it, then a resume at another head",
    () => {
      const w = promotion();
      return Effect.gen(function* () {
        expect(yield* trunkStanding(PROJECT)).toEqual(Option.none());
        const base = yield* w.seeded;
        w.clock.advance(5_000);
        const tip = yield* w.composed(1, base);
        yield* deliver(verified(1, base));
        yield* flushTrunk(PROJECT);
        expect(yield* pushPromotion(PROJECT)).toBe("advanced");
        const store = yield* EntityStore;
        store.put("trunk", PROJECT, beforeItsTime(store.get("trunk", PROJECT)));
        expect(trunkOf(store, PROJECT)).toMatchObject({ head: tip });
        expect(trunkOf(store, PROJECT)?.advancedAt).toBeUndefined();
        const [initialized, advanced] = (yield* trunkLog)
          .filter((e) => e.type === "TrunkInitialized" || e.type === "TrunkAdvanced")
          .map((e) => e.at);
        expect(advanced).toBe(Instant((initialized ?? 0) + 5_000));
        expect(yield* trunkStanding(PROJECT)).toEqual(
          Option.some({ head: tip, phase: "idle", advancedAt: advanced }),
        );
        // Someone else's commit reaches trunk: the next batch freezes it, and it is shown frozen where Keel left it.
        w.clock.advance(5_000);
        yield* w.composed(2, tip);
        w.writer.interfere(sha("f"));
        yield* deliver(verified(2, tip));
        expect(yield* flushTrunk(PROJECT)).toBe("frozen");
        expect(yield* trunkStanding(PROJECT)).toEqual(
          Option.some({ head: tip, phase: "frozen", advancedAt: advanced }),
        );
        // The operator takes that commit as trunk's head: the head changed then, and the stored trunk says so.
        w.clock.advance(5_000);
        const resumedAt = Instant((advanced ?? 0) + 10_000);
        expect(yield* resumeTrunk(PROJECT, RELEASER)).toMatchObject({
          head: sha("f"),
          advancedAt: resumedAt,
        });
        store.put("trunk", PROJECT, beforeItsTime(store.get("trunk", PROJECT)));
        expect(yield* trunkStanding(PROJECT)).toEqual(
          Option.some({ head: sha("f"), phase: "debouncing", advancedAt: resumedAt }),
        );
      }).pipe(Effect.provide(w.layer));
    },
  );
});
