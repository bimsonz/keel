import {
  admitUsage,
  configureUsage,
  recordUsage,
  usageSettings,
} from "@keeltown/core/application/identity";
import { NamespaceUsage } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { type ManualClock, makeManualClock } from "./event-outbox.ts";
import { makeEntityStoreMemory } from "./storage.ts";

/**
 * NamespaceUsage in memory: the same counting the NamespaceUsage object runs, over one
 * in-memory store for every namespace, on a clock a test can move (a daily kind
 * resets at UTC midnight).
 */
export function makeNamespaceUsageMemory(options: { readonly clock?: ManualClock } = {}) {
  const clock = options.clock ?? makeManualClock();
  const held = Layer.mergeAll(makeEntityStoreMemory().layer, clock.layer);
  return {
    clock,
    layer: Layer.succeed(
      NamespaceUsage,
      NamespaceUsage.of({
        admit: (namespace, kind, amount, key) =>
          admitUsage(namespace, kind, amount, key).pipe(Effect.provide(held)),
        record: (namespace, kind, amount, key) =>
          recordUsage(namespace, kind, amount, key).pipe(Effect.provide(held)),
        settings: (namespace) => usageSettings(namespace).pipe(Effect.provide(held)),
        configure: (namespace, settings) =>
          configureUsage(namespace, settings).pipe(Effect.provide(held)),
      }),
    ),
  };
}
