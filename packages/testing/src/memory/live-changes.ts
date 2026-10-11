import { hearLiveChange, liveChanges } from "@keeltown/core/application/coordination";
import type { EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import { type EntityStore, LiveChanges } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { makeEntityStoreMemory } from "./storage.ts";

type Store = (typeof EntityStore)["Service"];

/**
 * LiveChanges in memory: one index per project, folded by the same
 * `hearLiveChange` the Project DO runs. `hear` feeds it an event of one of
 * the project's changes, as the fan-out would.
 */
export function makeLiveChangesMemory() {
  const indexes = new Map<ProjectId, Store>();
  const indexOf = (projectId: ProjectId): Store => {
    let store = indexes.get(projectId);
    if (store === undefined) {
      store = makeEntityStoreMemory().service;
      indexes.set(projectId, store);
    }
    return store;
  };
  return {
    hear: (projectId: ProjectId, event: EventEnvelope): void => {
      const store = indexOf(projectId);
      store.transaction(() => hearLiveChange(store, event));
    },
    layer: Layer.succeed(
      LiveChanges,
      LiveChanges.of({ of: (projectId) => Effect.sync(() => liveChanges(indexOf(projectId))) }),
    ),
  };
}
