import type { Clock, EntityStore, Ids } from "@keeltown/core/ports";
import { Layer, ManagedRuntime } from "effect";
import { EntityStoreSql, migrateEntityStore } from "../adapters/driven/do-storage/entity-store.ts";
import { SystemLive } from "../adapters/driven/system.ts";

export type DurableObjectServices = EntityStore | Clock | Ids;
export type DurableObjectRuntime = ManagedRuntime.ManagedRuntime<DurableObjectServices, never>;

/**
 * A Durable Object's composition root, called once from its constructor.
 * Migrations run inside `blockConcurrencyWhile`, so no request sees a half-built
 * schema; the runtime lives as long as the instance.
 */
export function durableObjectRuntime(ctx: DurableObjectState): DurableObjectRuntime {
  void ctx.blockConcurrencyWhile(async () => migrateEntityStore(ctx.storage));
  return ManagedRuntime.make(Layer.mergeAll(EntityStoreSql(ctx.storage), SystemLive));
}
