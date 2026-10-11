// The Trunk's bootstrapping over in-memory ports: Initialize through the
// domain's Promotion machine and commit(), and the project repo convention.
import { describe, expect, it } from "@effect/vitest";
import {
  initializeTrunk,
  projectRepos,
  syncTrunk,
  trunkOf,
} from "@keeltown/core/application/integration";
import { CommitSha, makeId, type ProjectId } from "@keeltown/core/kernel";
import { EntityStore, EventOutbox } from "@keeltown/core/ports";
import { makeClockMemory, makeEventOutboxMemory, makeTrunkWriterMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

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
