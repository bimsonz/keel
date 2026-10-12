import {
  admitUsage,
  configureUsage,
  recordUsage,
  usageSettings,
} from "@keeltown/core/application/identity";
import { OrgUsage } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { type ManualClock, makeManualClock } from "./event-outbox.ts";
import { makeEntityStoreMemory } from "./storage.ts";

/**
 * OrgUsage in memory: the same counting the OrgUsage object runs, over one
 * in-memory store for every org, on a clock a test can move (a daily kind
 * resets at UTC midnight).
 */
export function makeOrgUsageMemory(options: { readonly clock?: ManualClock } = {}) {
  const clock = options.clock ?? makeManualClock();
  const held = Layer.mergeAll(makeEntityStoreMemory().layer, clock.layer);
  return {
    clock,
    layer: Layer.succeed(
      OrgUsage,
      OrgUsage.of({
        admit: (org, kind, amount, key) =>
          admitUsage(org, kind, amount, key).pipe(Effect.provide(held)),
        record: (org, kind, amount, key) =>
          recordUsage(org, kind, amount, key).pipe(Effect.provide(held)),
        settings: (org) => usageSettings(org).pipe(Effect.provide(held)),
        configure: (org, settings) => configureUsage(org, settings).pipe(Effect.provide(held)),
      }),
    ),
  };
}
