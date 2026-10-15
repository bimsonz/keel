import { describe, expect, it } from "@effect/vitest";
import { cancelBatch, initializeTrunk, trunkOf } from "@keeltown/core/application/integration";
import { Trunk } from "@keeltown/core/domain/integration";
import { CommitSha, makeId, type NamespaceId, type ProjectId } from "@keeltown/core/kernel";
import { EntityStore, EventOutbox } from "@keeltown/core/ports";
import {
  makeClockMemory,
  makeEventOutboxMemory,
  makeNamespaceUsageMemory,
  makeProjectNamespacesMemory,
  makeTrunkWriterMemory,
} from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const PROJECT: ProjectId = makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const ORG: NamespaceId = makeId("org", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const RED = makeId("bat", "01J9ZZZZZZZZZZZZZZZZZZZZZ1");
const BEHIND = makeId("bat", "01J9ZZZZZZZZZZZZZZZZZZZZZ2");
const MEMBER = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZ2");

/** The outbox and its store, a clock, usage, a trunk writer at `a`, and the project placed in ORG. */
const layer = () => {
  const places = makeProjectNamespacesMemory();
  places.places.set(PROJECT, { projectId: PROJECT, namespace: ORG, name: "app" });
  return Layer.mergeAll(
    makeEventOutboxMemory().layer,
    makeClockMemory().layer,
    places.layer,
    makeNamespaceUsageMemory().layer,
    makeTrunkWriterMemory(sha("a")).layer,
  );
};

const dropsLogged = Effect.map(
  EventOutbox,
  (outbox) =>
    outbox.log({ kind: "trunk", id: PROJECT }).filter((e) => e.type === "BatchDropped").length,
);

describe("a cancel at the trunk", () => {
  it.effect(
    "[trunk.cancel] a batch whose verdict has not arrived is dropped and remembered, a retry answers dropped again with nothing recorded, and a batch a member of which landed is too late",
    () =>
      Effect.gen(function* () {
        yield* initializeTrunk(PROJECT, sha("a"), "seed", { kind: "empty" });
        const cancel = { batchId: BEHIND, because: RED, members: [MEMBER] };
        expect(yield* cancelBatch(PROJECT, cancel)).toEqual({ _tag: "dropped" });
        expect(yield* cancelBatch(PROJECT, cancel)).toEqual({ _tag: "dropped" });
        expect(yield* dropsLogged).toBe(1);
        const store = yield* EntityStore;
        expect(trunkOf(store, PROJECT)?.dropped).toEqual([BEHIND]);
        // The member landed through another batch: this one is too late to drop.
        const trunk = trunkOf(store, PROJECT);
        expect(trunk).toBeDefined();
        if (trunk !== undefined)
          store.put(
            "trunk",
            PROJECT,
            Schema.encodeSync(Schema.toCodecJson(Trunk))({ ...trunk, promoted: [MEMBER] }),
          );
        const landed = {
          batchId: makeId("bat", "01J9ZZZZZZZZZZZZZZZZZZZZZ3"),
          because: RED,
          members: [MEMBER],
        };
        expect(yield* cancelBatch(PROJECT, landed)).toEqual({
          _tag: "too-late",
          reason: "promoted",
        });
        expect(yield* dropsLogged).toBe(1);
      }).pipe(Effect.provide(layer())),
  );
});
