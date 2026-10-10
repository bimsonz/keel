import { NotImplemented } from "@keeltown/core/not-implemented";
import {
  type Clock,
  type CodeHost,
  type EntityStore,
  type EventOutbox,
  type FanOut,
  type Ids,
  WorkspacePool,
} from "@keeltown/core/ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CodeHostArtifacts } from "../adapters/driven/artifacts/code-host.ts";
import { FanOutRpc } from "../adapters/driven/do-rpc/fan-out.ts";
import { EntityStoreSql, migrateEntityStore } from "../adapters/driven/do-storage/entity-store.ts";
import { EventOutboxSql, migrateEventOutbox } from "../adapters/driven/do-storage/event-outbox.ts";
import { SystemLive } from "../adapters/driven/system.ts";
import { migrateAlarms } from "../adapters/driving/do/alarm.ts";

export type DurableObjectServices = EntityStore | EventOutbox | Clock | Ids;
/** An object's runtime: the backbone's services, and `R`, the driven adapters its own use-cases need. */
export type DurableObjectRuntime<R = never> = ManagedRuntime.ManagedRuntime<
  DurableObjectServices | R,
  never
>;

/** The services every Durable Object runs on: its own storage and outbox, the system clock and ids. */
export function backbone(storage: DurableObjectStorage): Layer.Layer<DurableObjectServices> {
  return Layer.mergeAll(EntityStoreSql(storage), EventOutboxSql(storage), SystemLive);
}

/** The Change DO's driven adapters beyond the backbone. */
export type ChangeServices = WorkspacePool;

/**
 * The Change DO takes its workspace from the WorkspacePool DO. The RPC
 * adapter replaces this placeholder, which dies with NotImplemented, so a
 * declare fails loudly instead of granting nothing.
 */
export function changeServices(_env: Env): Layer.Layer<ChangeServices> {
  return Layer.succeed(
    WorkspacePool,
    WorkspacePool.of({ grant: poolPending, release: poolPending }),
  );
}

const poolPending = () => Effect.die(new NotImplemented("WorkspacePool RPC adapter"));

export interface DurableObjectComposition<R = never> {
  readonly runtime: DurableObjectRuntime<R>;
  /** How this object's committed events reach their subscribers. */
  readonly fanOut: FanOut;
}

/**
 * A Durable Object's composition root, called once from its constructor.
 * Migrations run inside `blockConcurrencyWhile`, so no request sees a half-built
 * schema; the runtime lives as long as the instance.
 */
export function durableObjectRuntime<R>(
  ctx: DurableObjectState,
  env: Env,
  driven: Layer.Layer<R>,
): DurableObjectComposition<R> {
  void ctx.blockConcurrencyWhile(async () => {
    migrateEntityStore(ctx.storage);
    migrateEventOutbox(ctx.storage);
    migrateAlarms(ctx.storage);
  });
  return {
    runtime: ManagedRuntime.make(Layer.mergeAll(backbone(ctx.storage), driven)),
    fanOut: FanOutRpc(env),
  };
}

/**
 * CodeHost over the Worker's Artifacts bindings, keyed by the namespace each is
 * bound to in wrangler.jsonc: `keel-core` (trunk, staging, guards) and
 * `keel-ws-00` (workspaces and their mirror).
 */
export function codeHostLayer(env: Env): Layer.Layer<CodeHost> {
  return CodeHostArtifacts({ "keel-core": env.ARTIFACTS, "keel-ws-00": env.WORKSPACES });
}
