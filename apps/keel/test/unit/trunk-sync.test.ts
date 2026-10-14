// A sync from upstream over in-memory ports: an imported trunk's main moved
// forward to its upstream branch's head through the Promotion machine, its
// write-ahead entry and its read-back, as the Trunk DO runs it.
import { describe, expect, it } from "@effect/vitest";
import {
  finishUpstreamSync,
  initializeTrunk,
  mainLane,
  syncFromUpstream,
  trunkOf,
} from "@keeltown/core/application/integration";
import type { TrunkOrigin } from "@keeltown/core/domain/integration";
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

/** The outbox, a clock, usage, a trunk writer at `a`, and the project placed in ORG. */
const ports = () => {
  const places = makeProjectNamespacesMemory();
  places.places.set(PROJECT, { projectId: PROJECT, namespace: ORG, name: "app" });
  const writer = makeTrunkWriterMemory(sha("a"));
  return {
    writer,
    layer: Layer.mergeAll(
      makeEventOutboxMemory().layer,
      makeClockMemory().layer,
      places.layer,
      makeNamespaceUsageMemory().layer,
      writer.layer,
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
