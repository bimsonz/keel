import {
  collectOnChangeEnd,
  collectWorkspaces,
  configurePool,
  grantWorkspace,
  poolStatus,
  refillPool,
  releaseWorkspace,
} from "@keeltown/core/application/coordination";
import { ChangeId, type EventEnvelope, SketchId, WorkspaceId } from "@keeltown/core/kernel";
import type { CodeHost, Transaction } from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";
import { codeHostLayer } from "../../../composition/do.ts";
import {
  CollectionReason,
  PoolConfig,
  WorkspacePoolCodecs,
  type WorkspacePoolRpc,
} from "../../../rpc/workspace-pool.ts";
import { type AlarmRequest, scheduleAlarm } from "./alarm.ts";
import { KeelObject, type Reaction } from "./keel-object.ts";

/** The pool's own deadlines, alongside the outbox's. */
export const POOL_REFILL = "pool refill";
export const POOL_COLLECT = "pool collect";
/** How long a failed fork or deletion waits before the next try. */
const RETRY_MS = 10_000;

const decodeHolder = Schema.decodeUnknownEffect(Schema.Union([ChangeId, SketchId]));
const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);
const decodeReason = Schema.decodeUnknownEffect(CollectionReason);
const decodeConfig = Schema.decodeUnknownEffect(PoolConfig);

/**
 * The WorkspacePool DO (`pool:<project>`): pre-forked workspaces. A workspace
 * is forked before anyone asks for it, because a fork takes seconds (S2); a
 * grant hands out one that is already ready. Refills and collections are
 * named deadlines, armed when there is work and never re-armed without it.
 * Repo-touching: callers place it with the deployment's `locationHint`.
 */
export class WorkspacePoolDO extends KeelObject implements WorkspacePoolRpc {
  private readonly codeHost: Layer.Layer<CodeHost> = codeHostLayer(this.env);

  /** The project this pool serves, from the object's name. */
  private get project(): string {
    const name = this.ctx.id.name;
    if (name?.startsWith("pool:") !== true)
      throw new Error("a WorkspacePool DO is addressed as pool:<project>");
    return name.slice("pool:".length);
  }

  async grant(holder: string) {
    const program = decodeHolder(holder).pipe(
      Effect.orDie,
      Effect.flatMap(grantWorkspace),
      Effect.provide(this.codeHost),
    );
    const answer = await this.answer(WorkspacePoolCodecs.grant, program);
    await this.refillIfShort();
    return answer;
  }

  async release(workspaceId: string, reason: string = "withdrawn") {
    const program = Effect.all([decodeWorkspaceId(workspaceId), decodeReason(reason)]).pipe(
      Effect.orDie,
      Effect.flatMap(([id, why]) => releaseWorkspace(id, why)),
    );
    const answer = await this.answer(WorkspacePoolCodecs.release, program);
    await scheduleAlarm(this.ctx.storage, {
      kind: "deadline",
      reason: POOL_COLLECT,
      at: Date.now(),
    });
    return answer;
  }

  async configure(config: unknown) {
    const project = this.project;
    const program = decodeConfig(config).pipe(
      Effect.orDie,
      Effect.flatMap((settings) => configurePool(project, settings)),
    );
    const answer = await this.answer(WorkspacePoolCodecs.configure, program);
    await this.refillIfShort();
    return answer;
  }

  async status() {
    return this.answer(WorkspacePoolCodecs.status, poolStatus());
  }

  /** A change that landed, was withdrawn or was superseded gives its workspace up; redelivery is a no-op. */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    const collected = collectOnChangeEnd(tx, event, Date.now());
    return collected === undefined
      ? undefined
      : { entity: { kind: "workspace", id: collected.workspaceId }, drafts: collected.drafts };
  }

  override async receive(envelopes: unknown) {
    const answer = await super.receive(envelopes);
    if ((await this.runtime.runPromise(poolStatus())).collecting > 0) {
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: POOL_COLLECT,
        at: Date.now(),
      });
    }
    return answer;
  }

  protected override async onDeadline(request: AlarmRequest): Promise<void> {
    if (request.reason === POOL_REFILL) {
      const report = await this.runtime.runPromise(
        refillPool().pipe(Effect.provide(this.codeHost)),
      );
      if (report.failed + report.abandoned > 0) {
        await scheduleAlarm(this.ctx.storage, {
          kind: "deadline",
          reason: POOL_COLLECT,
          at: Date.now(),
        });
      }
      if (report.failed > 0) {
        await scheduleAlarm(this.ctx.storage, {
          kind: "deadline",
          reason: POOL_REFILL,
          at: Date.now() + RETRY_MS,
        });
      }
      return;
    }
    if (request.reason === POOL_COLLECT) {
      const report = await this.runtime.runPromise(
        collectWorkspaces().pipe(Effect.provide(this.codeHost)),
      );
      if (report.pending > 0) {
        await scheduleAlarm(this.ctx.storage, {
          kind: "deadline",
          reason: POOL_COLLECT,
          at: Date.now() + RETRY_MS,
        });
      }
      return;
    }
    await super.onDeadline(request);
  }

  /** Arms a refill now if the pool holds fewer ready or forking workspaces than its target. */
  private async refillIfShort(): Promise<void> {
    const status = await this.runtime.runPromise(poolStatus());
    if (status.source !== null && status.ready + status.forking < status.target) {
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: POOL_REFILL,
        at: Date.now(),
      });
    }
  }
}
