// A sync from upstream over in-memory ports: an imported trunk's main moved
// forward to its upstream branch's head through the Promotion machine, its
// write-ahead entry and its read-back, as the Trunk DO runs it.
import { describe, expect, it } from "@effect/vitest";
import {
  finishUpstreamSync,
  initializeTrunk,
  mainLane,
  projectRepos,
  syncFromUpstream,
  trunkOf,
  upstreamPoints,
} from "@keeltown/core/application/integration";
import { Trunk, type TrunkOrigin } from "@keeltown/core/domain/integration";
import {
  CommitSha,
  makeId,
  type NamespaceId,
  type ProjectId,
  userActor,
} from "@keeltown/core/kernel";
import { EntityStore, EventOutbox, NamespaceUsage } from "@keeltown/core/ports";
import {
  makeClockMemory,
  makeEventOutboxMemory,
  makeNamespaceUsageMemory,
  makeProjectNamespacesMemory,
  makeTrunksMemory,
  makeTrunkWriterMemory,
} from "@keeltown/testing";
import { Effect, Layer, Result, Schema } from "effect";
import { ulid } from "ulid";

const PROJECT: ProjectId = makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const ORG: NamespaceId = makeId("org", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const OWNER = userActor(makeId("usr", "01J9ZZZZZZZZZZZZZZZZZZZZZZ"));
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const UPSTREAM = { url: "https://git.example/team/app", ref: "refs/heads/main" };
const IMPORTED: TrunkOrigin = { kind: "imported", ...UPSTREAM, commit: sha("a") };

/** The project a fork was taken from, at `a`. */
const UPSTREAM_PROJECT: ProjectId = makeId("prj", "01J9VVVVVVVVVVVVVVVVVVVVVV");
const FORKED: TrunkOrigin = { kind: "forked", project: UPSTREAM_PROJECT, commit: sha("a") };
const UPSTREAM_TRUNK = projectRepos(UPSTREAM_PROJECT).trunk;

/** The outbox, a clock, usage, a trunk writer at `a`, the project placed in ORG, and the other projects' trunks. */
const ports = () => {
  const places = makeProjectNamespacesMemory();
  places.places.set(PROJECT, { projectId: PROJECT, namespace: ORG, name: "app" });
  const writer = makeTrunkWriterMemory(sha("a"));
  const trunks = makeTrunksMemory();
  return {
    writer,
    trunks,
    layer: Layer.mergeAll(
      makeEventOutboxMemory().layer,
      makeClockMemory().layer,
      places.layer,
      makeNamespaceUsageMemory().layer,
      writer.layer,
      trunks.layer,
    ),
  };
};

/** What ORG's repo bytes count now. */
const counted = Effect.map(
  Effect.flatMap(NamespaceUsage, (usage) => usage.admit(ORG, "repo-bytes", 0, `probe-${ulid()}`)),
  (answer) => answer.limit - answer.remaining,
);

const typesOf = Effect.map(EventOutbox, (outbox) =>
  outbox.log({ kind: "trunk", id: PROJECT }).map((e) => e.type),
);

/** Upstream two commits past the import: `b` on `a`, then `c` on `b`. */
const ahead = (writer: ReturnType<typeof makeTrunkWriterMemory>, bytes = 900) =>
  writer.offersUpstream(
    UPSTREAM,
    sha("c"),
    [
      { sha: sha("b"), parents: [sha("a")] },
      { sha: sha("c"), parents: [sha("b")] },
    ],
    bytes,
  );

describe("a sync from upstream", () => {
  it.effect(
    "[sync.moves] an imported trunk moves to upstream's head through TrunkSyncStarted and TrunkSynced, its pack counted once and its side ref dropped",
    () => {
      const w = ports();
      ahead(w.writer);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
        const before = yield* counted;
        const answer = yield* syncFromUpstream(PROJECT, OWNER);
        expect(answer).toEqual({ from: sha("a"), to: sha("c"), synced: true });
        expect(w.writer.head()).toBe(sha("c"));
        expect(trunkOf(yield* EntityStore, PROJECT)).toMatchObject({
          phase: "idle",
          head: sha("c"),
          height: 1,
        });
        expect(yield* typesOf).toEqual(["TrunkInitialized", "TrunkSyncStarted", "TrunkSynced"]);
        // The pack less its 32 bytes of header and trailer, as a promotion's is counted.
        expect((yield* counted) - before).toBe(900 - 32);
        expect(w.writer.side()).toBeUndefined();
        expect(w.writer.fetched()).toEqual([{ to: sha("c"), haves: [sha("a")] }]);
        // The main lane hears the sync, so staging follows trunk's new head.
        expect((yield* EventOutbox).subscribers("TrunkSynced")).toContain(mainLane(PROJECT));
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[sync.ff-only] an upstream whose head does not descend from trunk's is NotFastForward naming both heads: main, the trunk, the log and the namespace's count are as they were, and the side ref is dropped",
    () => {
      const w = ports();
      // Upstream's history was rewritten: `d` does not reach trunk's head.
      w.writer.offersUpstream(UPSTREAM, sha("d"), [{ sha: sha("d"), parents: [sha("9")] }], 900);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
        const trunk = trunkOf(yield* EntityStore, PROJECT);
        const before = yield* counted;
        const refused = yield* Effect.result(syncFromUpstream(PROJECT, OWNER));
        expect(Result.isFailure(refused) ? refused.failure : undefined).toMatchObject({
          _tag: "NotFastForward",
          projectId: PROJECT,
          trunk: sha("a"),
          upstream: sha("d"),
        });
        expect(w.writer.head()).toBe(sha("a"));
        expect(w.writer.fastForwards()).toEqual([]);
        expect(trunkOf(yield* EntityStore, PROJECT)).toEqual(trunk);
        expect(yield* typesOf).toEqual(["TrunkInitialized"]);
        expect(yield* counted).toBe(before);
        expect(w.writer.side()).toBeUndefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[sync.cas] main moves only from the head the sync started at: a main moved under it is left where it is, and the sync freezes promotion",
    () => {
      const w = ports();
      ahead(w.writer);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
        // Someone else moved trunk's main: the sync's push names `a`, so it must be refused.
        w.writer.interfere(sha("e"));
        yield* syncFromUpstream(PROJECT, OWNER);
        expect(w.writer.head()).toBe(sha("e"));
        expect(w.writer.fastForwards()).toEqual([]);
        expect(trunkOf(yield* EntityStore, PROJECT)).toMatchObject({
          phase: "frozen",
          head: sha("a"),
        });
        expect(yield* typesOf).toEqual(["TrunkInitialized", "TrunkSyncStarted", "PromotionFrozen"]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[sync.busy] a move the code host keeps busy leaves the sync open and answers it unsynced; the next try lands it",
    () => {
      const w = ports();
      ahead(w.writer);
      w.writer.busy(1);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
        expect(yield* syncFromUpstream(PROJECT, OWNER)).toEqual({
          from: sha("a"),
          to: sha("c"),
          synced: false,
        });
        expect(trunkOf(yield* EntityStore, PROJECT)?.phase).toBe("syncing");
        expect(yield* finishUpstreamSync(PROJECT)).toBe("idle");
        expect(w.writer.head()).toBe(sha("c"));
        expect(yield* typesOf).toEqual(["TrunkInitialized", "TrunkSyncStarted", "TrunkSynced"]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[sync.imported-only] a trunk that was not imported is NotImported, and nothing is read or fetched",
    () => {
      const w = ports();
      ahead(w.writer);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", {
          kind: "template",
          name: "starter",
          commit: sha("a"),
        });
        const refused = yield* Effect.result(syncFromUpstream(PROJECT, OWNER));
        expect(Result.isFailure(refused) ? refused.failure._tag : "synced").toBe("NotImported");
        expect(w.writer.fetched()).toEqual([]);
        expect(w.writer.head()).toBe(sha("a"));
        expect(yield* typesOf).toEqual(["TrunkInitialized"]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[sync.level] an upstream at trunk's head answers synced false and fetches, counts and records nothing",
    () => {
      const w = ports();
      w.writer.offersUpstream(UPSTREAM, sha("a"), []);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
        const before = yield* counted;
        expect(yield* syncFromUpstream(PROJECT, OWNER)).toEqual({
          from: sha("a"),
          to: sha("a"),
          synced: false,
        });
        expect(w.writer.fetched()).toEqual([]);
        expect(yield* counted).toBe(before);
        expect(yield* typesOf).toEqual(["TrunkInitialized"]);
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[sync.unreachable] an upstream that does not answer, or lost the branch, is UpstreamUnreachable with nothing moved",
    () => {
      const gone = ports();
      gone.writer.offersUpstream(UPSTREAM, undefined, []);
      const silent = ports();
      silent.writer.unreachable(UPSTREAM);
      const reasonOf = (w: ReturnType<typeof ports>) =>
        Effect.gen(function* () {
          yield* initializeTrunk(PROJECT, sha("a"), "seed", IMPORTED);
          const refused = yield* Effect.result(syncFromUpstream(PROJECT, OWNER));
          return {
            refused: Result.isFailure(refused) ? refused.failure : undefined,
            head: w.writer.head(),
          };
        }).pipe(Effect.provide(w.layer));
      return Effect.gen(function* () {
        expect(yield* reasonOf(gone)).toMatchObject({
          refused: { _tag: "UpstreamUnreachable", reason: "branch-gone" },
          head: sha("a"),
        });
        expect(yield* reasonOf(silent)).toMatchObject({
          refused: { _tag: "UpstreamUnreachable", reason: "unreachable" },
          head: sha("a"),
        });
      });
    },
  );
});

/** The upstream's trunk two commits past the fork point: `b` on `a`, then `c` on `b`. */
const upstreamAhead = (w: ReturnType<typeof ports>, bytes = 900) => {
  w.trunks.heads.set(UPSTREAM_PROJECT, sha("c"));
  w.writer.offersProject(
    UPSTREAM_TRUNK,
    sha("c"),
    [
      { sha: sha("b"), parents: [sha("a")] },
      { sha: sha("c"), parents: [sha("b")] },
    ],
    bytes,
  );
};

/** The fork lands a commit of its own, `f` on `a`, as a promotion would leave trunk. */
const landedInFork = (w: ReturnType<typeof ports>) =>
  Effect.gen(function* () {
    const store = yield* EntityStore;
    const trunk = trunkOf(store, PROJECT);
    if (trunk === undefined) throw new Error("the fork's trunk is not initialized");
    store.put(
      "trunk",
      PROJECT,
      Schema.encodeSync(Schema.toCodecJson(Trunk))({ ...trunk, head: sha("f") }),
    );
    w.writer.interfere(sha("f"));
  });

/** The payload of the trunk's last event of `type`. */
const lastOf = (type: string) =>
  Effect.map(
    EventOutbox,
    (outbox) =>
      outbox
        .log({ kind: "trunk", id: PROJECT })
        .filter((e) => e.type === type)
        .at(-1)?.payload,
  );

describe("a fork's sync with its upstream", () => {
  it.effect(
    "[fork-sync.ff] a fork with nothing of its own moves to its upstream trunk's head, relayed from the upstream's trunk on the fork point and counted once",
    () => {
      const w = ports();
      upstreamAhead(w);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "fork", FORKED);
        const before = yield* counted;
        expect(yield* syncFromUpstream(PROJECT, OWNER)).toEqual({
          from: sha("a"),
          to: sha("c"),
          synced: true,
        });
        expect(w.writer.head()).toBe(sha("c"));
        expect(w.writer.fetchedProjects()).toEqual([
          { source: UPSTREAM_TRUNK, to: sha("c"), haves: [sha("a")] },
        ]);
        expect(w.writer.merges()).toEqual([]);
        expect(yield* lastOf("TrunkSynced")).toEqual({
          _tag: "TrunkSynced",
          projectId: PROJECT,
          from: sha("a"),
          to: sha("c"),
          by: OWNER,
          upstream: { project: UPSTREAM_PROJECT },
          height: 1,
        });
        expect((yield* counted) - before).toBe(900 - 32);
        expect(w.writer.side()).toBeUndefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[fork-sync.merge] a fork holding a landing of its own moves to Keel's merge of the upstream's head on the fork point, its first parent the fork's head, and both packs are counted",
    () => {
      const w = ports();
      upstreamAhead(w);
      w.writer.mergeWeighs(400);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "fork", FORKED);
        yield* landedInFork(w);
        const before = yield* counted;
        const answer = yield* syncFromUpstream(PROJECT, OWNER);
        const [merge] = w.writer.merges();
        expect(merge).toMatchObject({ ours: sha("f"), theirs: sha("c"), base: sha("a") });
        expect(answer).toEqual({ from: sha("f"), to: merge?.commit, synced: true });
        expect(w.writer.parentsOf(merge?.commit ?? sha("0"))).toEqual([sha("f"), sha("c")]);
        expect(yield* lastOf("TrunkSynced")).toMatchObject({
          from: sha("f"),
          to: merge?.commit,
          upstream: { project: UPSTREAM_PROJECT },
          merged: sha("c"),
        });
        expect(w.writer.head()).toBe(merge?.commit);
        expect((yield* counted) - before).toBe(900 - 32 + (400 - 32));
        expect(w.writer.side()).toBeUndefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[fork-sync.level] a fork already holding its upstream's head, by a fast-forward or Keel's merge, answers synced false and fetches, counts and records nothing",
    () => {
      const ff = ports();
      ff.trunks.heads.set(UPSTREAM_PROJECT, sha("a"));
      const merged = ports();
      upstreamAhead(merged);
      return Effect.gen(function* () {
        const level = yield* Effect.gen(function* () {
          yield* initializeTrunk(PROJECT, sha("a"), "fork", FORKED);
          return yield* syncFromUpstream(PROJECT, OWNER);
        }).pipe(Effect.provide(ff.layer));
        expect(level).toEqual({ from: sha("a"), to: sha("a"), synced: false });
        expect(ff.writer.fetchedProjects()).toEqual([]);
        yield* Effect.gen(function* () {
          yield* initializeTrunk(PROJECT, sha("a"), "fork", FORKED);
          yield* landedInFork(merged);
          const first = yield* syncFromUpstream(PROJECT, OWNER);
          const before = yield* counted;
          const again = yield* syncFromUpstream(PROJECT, OWNER);
          expect(again).toEqual({ from: first.to, to: first.to, synced: false });
          expect(merged.writer.fetchedProjects()).toHaveLength(1);
          expect(merged.writer.merges()).toHaveLength(1);
          expect(yield* counted).toBe(before);
          expect((yield* typesOf).filter((t) => t === "TrunkSynced")).toHaveLength(1);
        }).pipe(Effect.provide(merged.layer));
      });
    },
  );

  it.effect(
    "[fork-sync.conflict] a path the fork and its upstream both changed apart is SyncConflicts naming it: main, the trunk, the log and the namespace's count are as they were, and the side ref is dropped",
    () => {
      const w = ports();
      upstreamAhead(w);
      w.writer.conflicts("src/a.ts", "both-modified");
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "fork", FORKED);
        yield* landedInFork(w);
        const trunk = trunkOf(yield* EntityStore, PROJECT);
        const before = yield* counted;
        const refused = yield* Effect.result(syncFromUpstream(PROJECT, OWNER));
        expect(Result.isFailure(refused) ? refused.failure : undefined).toMatchObject({
          _tag: "SyncConflicts",
          projectId: PROJECT,
          path: "src/a.ts",
          reason: "both-modified",
        });
        expect(w.writer.head()).toBe(sha("f"));
        expect(trunkOf(yield* EntityStore, PROJECT)).toEqual(trunk);
        expect(yield* typesOf).toEqual(["TrunkInitialized"]);
        expect(yield* counted).toBe(before);
        expect(w.writer.side()).toBeUndefined();
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[fork-sync.points] each sync adds where the fork met its upstream, newest first and ending at the fork point, and a later merge is made on the newest",
    () => {
      const w = ports();
      upstreamAhead(w);
      return Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "fork", FORKED);
        expect(yield* upstreamPoints(PROJECT)).toEqual([{ at: sha("a"), upstream: sha("a") }]);
        yield* syncFromUpstream(PROJECT, OWNER);
        const store = yield* EntityStore;
        const trunk = trunkOf(store, PROJECT);
        if (trunk === undefined) throw new Error("no trunk");
        store.put(
          "trunk",
          PROJECT,
          Schema.encodeSync(Schema.toCodecJson(Trunk))({ ...trunk, head: sha("f") }),
        );
        w.writer.interfere(sha("f"));
        w.trunks.heads.set(UPSTREAM_PROJECT, sha("e"));
        w.writer.offersProject(UPSTREAM_TRUNK, sha("e"), [
          { sha: sha("d"), parents: [sha("c")] },
          { sha: sha("e"), parents: [sha("d")] },
        ]);
        const merged = yield* syncFromUpstream(PROJECT, OWNER);
        expect(w.writer.merges().map((m) => m.base)).toEqual([sha("c")]);
        expect(w.writer.fetchedProjects().at(-1)?.haves).toEqual([sha("c"), sha("a")]);
        expect(yield* upstreamPoints(PROJECT)).toEqual([
          { at: merged.to, upstream: sha("e") },
          { at: sha("c"), upstream: sha("c") },
          { at: sha("a"), upstream: sha("a") },
        ]);
      }).pipe(Effect.provide(w.layer));
    },
  );
});
