import {
  collectOnChangeEnd,
  collectWorkspaces,
  configurePool,
  countBehind,
  destroyPool,
  grantWorkspace,
  observePush,
  poolStatus,
  refillPool,
  refreshSlots,
  releaseWorkspace,
  STUCK_REFRESH_MS,
} from "@keeltown/core/application/coordination";
import {
  ChangeId,
  type EventEnvelope,
  ProjectId,
  SketchId,
  WorkspaceId,
} from "@keeltown/core/kernel";
import { REDELIVERY_CAP_MS, redeliveryDelay, type Transaction } from "@keeltown/core/ports";
import { Cause, Effect, Exit, type Layer, Schema } from "effect";
import { type PoolServices, poolServices } from "../../../composition/do.ts";
import {
  CollectionReason,
  ObservedPush,
  PoolConfig,
  WorkspacePoolCodecs,
  type WorkspacePoolRpc,
} from "../../../rpc/workspace-pool.ts";
import { armedAlarms, cancelAlarm, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObject, type Reaction } from "./keel-object.ts";

/** The pool's own deadlines, alongside the outbox's. */
export const POOL_REFILL = "pool refill";
export const POOL_COLLECT = "pool collect";
export const POOL_REFRESH = "pool refresh";
/** A claim's own: when a workspace it may have left mid-relay is settled. */
export const POOL_CLAIM = "pool claim";
/** How long a failed fork or deletion waits before the next try. */
const RETRY_MS = 10_000;

const decodeHolder = Schema.decodeUnknownEffect(Schema.Union([ChangeId, SketchId]));
const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);
const decodeReason = Schema.decodeUnknownEffect(CollectionReason);
const decodeConfig = Schema.decodeUnknownEffect(PoolConfig);
const decodePush = Schema.decodeUnknownEffect(ObservedPush);
const decodeProject = Schema.decodeUnknownSync(ProjectId);

/**
 * The WorkspacePool DO (`pool:<project>`): pre-forked workspaces. A workspace
 * is forked before anyone asks for it, because a fork takes seconds (S2); a
 * grant hands out one that is already ready. Refills, collections and
 * refreshes are named deadlines, armed when there is work and never re-armed
 * without it. A refresh brings the ready workspaces up to trunk's head: it is
 * armed when a change lands, and when a refill leaves a workspace behind
 * trunk (the mirror it forks from can lag). A claim that arrives before it
 * brings the workspace it takes to trunk's head itself.
 * Repo-touching: callers place it with the deployment's `locationHint`.
 */
export class WorkspacePoolDO extends KeelObject implements WorkspacePoolRpc {
  private readonly services: Layer.Layer<PoolServices> = poolServices(this.env);
  /** A delivery of this request carried a landing: trunk has moved, so the ready workspaces are behind it. */
  private landed = false;
  /** Refresh passes in a row that failed or left a workspace behind; the next waits longer for each. */
  private refreshFailures = 0;
  /** The claims being served now: each may be relaying trunk into the workspace it takes. */
  private claims = 0;

  /** The project this pool serves, from the object's name; stamped on every event it commits. */
  private get project(): ProjectId {
    const name = this.ctx.id.name;
    if (name?.startsWith("pool:") !== true)
      throw new Error("a WorkspacePool DO is addressed as pool:<project>");
    return decodeProject(name.slice("pool:".length));
  }

  /**
   * A claim, and what follows it. A claim may relay trunk into the workspace
   * it takes, and the object can die under that relay as under a pass's. So
   * a deadline of the claim's own is armed first, for when a workspace left
   * mid-relay may be settled; a pass then settles it. It is the claims' and
   * not the refresh's, so a pass that ends while a claim is still being
   * served withdraws nothing of it. Once no claim is being served and no
   * workspace is mid-relay it is withdrawn. A workspace the claim gave up is
   * collected, and the refill forks what the pool lacks.
   */
  async grant(holder: string) {
    const project = this.project;
    const storage = this.ctx.storage;
    const program = decodeHolder(holder).pipe(
      Effect.orDie,
      Effect.flatMap((h) => grantWorkspace(project, h)),
      Effect.provide(this.services),
    );
    // Counted before the first await, so a claim ending meanwhile does not withdraw this one's deadline.
    this.claims += 1;
    await scheduleAlarm(storage, {
      kind: "deadline",
      reason: POOL_CLAIM,
      at: Date.now() + STUCK_REFRESH_MS + 1_000,
    });
    const answer = await this.answer(WorkspacePoolCodecs.grant, program).finally(() => {
      this.claims -= 1;
    });
    const status = await this.runtime.runPromise(poolStatus());
    if (this.claims === 0 && status.refreshing === 0) await cancelAlarm(storage, POOL_CLAIM);
    const collecting = armedAlarms(storage).some((armed) => armed.reason === POOL_COLLECT);
    if (status.collecting > 0 && !collecting) {
      await scheduleAlarm(storage, { kind: "deadline", reason: POOL_COLLECT, at: Date.now() });
    }
    await this.refillIfShort();
    return answer;
  }

  async release(workspaceId: string, reason: string = "withdrawn") {
    const project = this.project;
    const program = Effect.all([decodeWorkspaceId(workspaceId), decodeReason(reason)]).pipe(
      Effect.orDie,
      Effect.flatMap(([id, why]) => releaseWorkspace(project, id, why)),
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

  async observePush(pushId: string, push: unknown) {
    const project = this.project;
    const program = decodePush(push).pipe(
      Effect.orDie,
      Effect.flatMap((pushed) => observePush(project, pushId, pushed)),
    );
    return this.answer(WorkspacePoolCodecs.observePush, program);
  }

  async destroy() {
    const project = this.project;
    const answer = await this.answer(
      WorkspacePoolCodecs.destroy,
      Effect.andThen(destroyPool(project), poolStatus()),
    );
    await cancelAlarm(this.ctx.storage, POOL_REFRESH);
    await scheduleAlarm(this.ctx.storage, {
      kind: "deadline",
      reason: POOL_COLLECT,
      at: Date.now(),
    });
    return answer;
  }

  /** A change that landed, was withdrawn or was superseded gives its workspace up; redelivery is a no-op. */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    if (event.type === "ChangeLanded") this.landed = true;
    const collected = collectOnChangeEnd(tx, event, Date.now());
    return collected === undefined
      ? undefined
      : {
          entity: { kind: "workspace", id: collected.workspaceId },
          drafts: collected.drafts,
          project: this.project,
        };
  }

  override async receive(envelopes: unknown) {
    const answer = await super.receive(envelopes);
    const status = await this.runtime.runPromise(poolStatus());
    if (status.collecting > 0) {
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: POOL_COLLECT,
        at: Date.now(),
      });
    }
    if (this.landed) {
      this.landed = false;
      if (status.ready > 0) {
        await scheduleAlarm(this.ctx.storage, {
          kind: "deadline",
          reason: POOL_REFRESH,
          at: Date.now(),
        });
      }
    }
    return answer;
  }

  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    if (request.reason === POOL_REFILL) {
      const report = await this.runtime.runPromise(
        refillPool(this.project).pipe(Effect.provide(this.services)),
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
      if (report.ready > 0) {
        // The mirror it forked from can lag trunk: what it left ready may already be behind.
        const behind = await this.runtime.runPromiseExit(
          countBehind(this.project).pipe(Effect.provide(this.services)),
        );
        // A count that fails is the refresh's to retry and report.
        if (Exit.isFailure(behind) || behind.value > 0) {
          await scheduleAlarm(this.ctx.storage, {
            kind: "deadline",
            reason: POOL_REFRESH,
            at: Date.now(),
          });
        }
      }
      return;
    }
    // A claim's deadline came due: the object died under its relay, or a relay is still out. A pass settles what it left.
    if (request.reason === POOL_REFRESH || request.reason === POOL_CLAIM) return this.refresh();
    if (request.reason === POOL_COLLECT) {
      const report = await this.runtime.runPromise(
        collectWorkspaces(this.project).pipe(Effect.provide(this.services)),
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

  /**
   * One refresh pass, and what follows it. A deadline is armed before the
   * pass starts, for when a slot left mid-relay may be settled: if the object
   * dies during a relay, that deadline still comes due. After the pass it is
   * withdrawn when nothing is left to do, and brought forward (backing off,
   * 1 s doubling to a minute) while a workspace is still behind or the pass
   * failed. A landing heard during the pass arms its own, which then stands.
   */
  private async refresh(): Promise<void> {
    const storage = this.ctx.storage;
    const fallback = Date.now() + STUCK_REFRESH_MS + 1_000;
    await scheduleAlarm(storage, { kind: "deadline", reason: POOL_REFRESH, at: fallback });
    const exit = await this.runtime.runPromiseExit(
      refreshSlots(this.project).pipe(Effect.provide(this.services)),
    );
    if (Exit.isSuccess(exit) && exit.value.failed > 0) {
      // What could not follow trunk is deleted, and the refill forks its replacement.
      await scheduleAlarm(storage, { kind: "deadline", reason: POOL_COLLECT, at: Date.now() });
      await this.refillIfShort();
    }
    const settled = Exit.isSuccess(exit) && exit.value.pending === 0;
    this.refreshFailures = settled ? 0 : this.refreshFailures + 1;
    if (armedAlarms(storage).find((armed) => armed.reason === POOL_REFRESH)?.at !== fallback)
      return;
    if (settled) return cancelAlarm(storage, POOL_REFRESH);
    const delay = redeliveryDelay(this.refreshFailures);
    const line = `pool ${this.project} refresh unfinished ${this.refreshFailures}x, next in ${delay} ms`;
    const why = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : JSON.stringify(exit.value);
    // Below the cap it is expected to clear (a workspace busy, a binding mid-deploy); at the cap a person should look.
    if (delay >= REDELIVERY_CAP_MS) console.error(line, why);
    else console.warn(line, why);
    await scheduleAlarm(storage, {
      kind: "deadline",
      reason: POOL_REFRESH,
      at: Date.now() + delay,
    });
  }

  /** Arms a refill now if the pool holds fewer ready, forking or refreshing workspaces than its target. */
  private async refillIfShort(): Promise<void> {
    const status = await this.runtime.runPromise(poolStatus());
    if (
      status.source !== null &&
      status.ready + status.forking + status.refreshing < status.target
    ) {
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: POOL_REFILL,
        at: Date.now(),
      });
    }
  }
}
