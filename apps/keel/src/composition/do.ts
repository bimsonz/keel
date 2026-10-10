import type { Clock, EntityStore, EventOutbox, FanOut, Ids } from "@keeltown/core/ports";
import { Layer, ManagedRuntime } from "effect";
import { FanOutRpc } from "../adapters/driven/do-rpc/fan-out.ts";
import { EntityStoreSql, migrateEntityStore } from "../adapters/driven/do-storage/entity-store.ts";
import { EventOutboxSql, migrateEventOutbox } from "../adapters/driven/do-storage/event-outbox.ts";
import { SystemLive } from "../adapters/driven/system.ts";
import { migrateAlarms } from "../adapters/driving/do/alarm.ts";

export type DurableObjectServices = EntityStore | EventOutbox | Clock | Ids;
export type DurableObjectRuntime = ManagedRuntime.ManagedRuntime<DurableObjectServices, never>;

export interface DurableObjectComposition {
  readonly runtime: DurableObjectRuntime;
  /** How this object's committed events reach their subscribers. */
  readonly fanOut: FanOut;
}

/**
 * A Durable Object's composition root, called once from its constructor.
 * Migrations run inside `blockConcurrencyWhile`, so no request sees a half-built
 * schema; the runtime lives as long as the instance.
 */
export function durableObjectRuntime(ctx: DurableObjectState, env: Env): DurableObjectComposition {
  void ctx.blockConcurrencyWhile(async () => {
    migrateEntityStore(ctx.storage);
    migrateEventOutbox(ctx.storage);
    migrateAlarms(ctx.storage);
  });
  return {
    runtime: ManagedRuntime.make(Layer.mergeAll(EntityStoreSql(ctx.storage), EventOutboxSql(ctx.storage), SystemLive)),
    fanOut: FanOutRpc(env),
  };
}
