import { DEFAULT_QUOTAS } from "@keeltown/core/domain/identity";
import { NamespaceId } from "@keeltown/core/kernel";
import { NamespaceUsage } from "@keeltown/core/ports";
import { Schema } from "effect";
import { type BoxGateServices, boxGateServices } from "../../../composition/do.ts";
import { cancelAlarm, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import {
  acquireLease,
  type BoxLease,
  type GateAnswer,
  liveLeases,
  nextDeadline,
  releaseLease,
  TIER2_BOX_CAP,
  TIER2_GATE,
} from "./boxgate-leases.ts";
import { KeelObjectWith } from "./keel-object.ts";

/** Where the gate keeps its leases. */
const LEASES = "leases";

/** Where the gate keeps the lanes it refused a box, each told once when one is freed. */
const WAITERS = "waiters";

/** The alarm reason of the soonest lease's deadline. */
const LEASE_LAPSES = "a box lease lapses";

/** The gate of a namespace is named `boxgate:<namespaceId>`. */
const namespaceOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(NamespaceId)(name?.replace(/^boxgate:/, ""));

/**
 * BoxGate: how many boxes a namespace runs at once, under the `durable_object`
 * scheduling policy, which refuses `max_instances` (R13). One object per
 * namespace (`boxgate:<namespaceId>`) serialises its asks; its limit is the
 * namespace's `concurrent-containers` (its own override before the
 * instance's default, and none while it is halted). A box holds a lease for
 * as long as it composes, and the alarm reclaims a lease whose holder never
 * gave it back. `boxgate:tier2` (TIER2_GATE) is the one gate that is no
 * namespace's: it counts keel-verify's Tier 2 boxes under their cap. A
 * refusal says why: no room (with when the soonest lease ends), or the
 * namespace halted. A lane refused for want of room is kept as a waiter and
 * told (`boxFreed`) when a lease is released or lapses, so it waits on the
 * gate's event rather than asking again.
 */
export class BoxGate extends KeelObjectWith<BoxGateServices> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, boxGateServices(env));
  }

  private get leases(): BoxLease[] {
    return this.ctx.storage.kv.get<BoxLease[]>(LEASES) ?? [];
  }

  private async keep(leases: readonly BoxLease[]): Promise<void> {
    this.ctx.storage.kv.put(LEASES, leases);
    const due = nextDeadline(leases);
    if (due === undefined) await cancelAlarm(this.ctx.storage, LEASE_LAPSES);
    else await scheduleAlarm(this.ctx.storage, { kind: "deadline", reason: LEASE_LAPSES, at: due });
  }

  /** The namespace's limit and whether it is halted, read before the leases so no ask interleaves between their read and write. */
  private async room(): Promise<{ readonly limit: number; readonly halted: boolean }> {
    if (this.ctx.id.name === TIER2_GATE) return { limit: TIER2_BOX_CAP, halted: false };
    const namespace = namespaceOf(this.ctx.id.name);
    const settings = await this.runtime.runPromise(
      NamespaceUsage.use((usage) => usage.settings(namespace)),
    );
    if (settings.halted) return { limit: 0, halted: true };
    return {
      limit: settings.overrides["concurrent-containers"] ?? DEFAULT_QUOTAS["concurrent-containers"],
      halted: false,
    };
  }

  /**
   * Asks for a box for `holder` for `ttlMs`; a holder with a live lease has it
   * renewed. A `waiter` refused for want of room is told when a box is freed.
   */
  async acquire(ask: {
    readonly holder: string;
    readonly ttlMs: number;
    readonly waiter?: string;
  }): Promise<GateAnswer> {
    const { limit, halted } = await this.room();
    const { leases, answer } = acquireLease(
      this.leases,
      { holder: ask.holder, ttlMs: ask.ttlMs, id: crypto.randomUUID() },
      limit,
      Date.now(),
    );
    await this.keep(leases);
    if (answer.granted) return answer;
    if (halted) return { ...answer, halted: true };
    if (ask.waiter !== undefined && !this.waitingLanes.includes(ask.waiter))
      this.ctx.storage.kv.put(WAITERS, [...this.waitingLanes, ask.waiter]);
    return answer;
  }

  /** Gives a lease back; one already gone, released or expired, changes nothing. A lease given back frees a box for the waiters. */
  async release(leaseId: string): Promise<void> {
    const before = liveLeases(this.leases, Date.now()).length;
    const after = releaseLease(this.leases, leaseId, Date.now());
    await this.keep(after);
    if (after.length < before) await this.tellWaiters();
  }

  /** How many more leases the limit allows now, never below 0. */
  async free(): Promise<number> {
    const { limit } = await this.room();
    return Math.max(0, limit - liveLeases(this.leases, Date.now()).length);
  }

  private get waitingLanes(): string[] {
    return this.ctx.storage.kv.get<string[]>(WAITERS) ?? [];
  }

  /**
   * Tells every lane refused a box that one was freed, once: each forms again
   * and asks anew, so one that is refused again waits again. A lane that does
   * not answer is dropped; it steps on its own deadline.
   */
  private async tellWaiters(): Promise<void> {
    const waiters = this.waitingLanes;
    if (waiters.length === 0) return;
    this.ctx.storage.kv.delete(WAITERS);
    await Promise.all(
      waiters.map((laneId) =>
        this.env.LANE.get(this.env.LANE.idFromName(laneId))
          .boxFreed()
          .catch((error: unknown) =>
            console.warn(`boxgate ${this.ctx.id.name}: lane ${laneId} not told: ${String(error)}`),
          ),
      ),
    );
  }

  /** How many leases are live, for tests and the operator. */
  async held(): Promise<number> {
    return liveLeases(this.leases, Date.now()).length;
  }

  /** Reclaims every lease past its deadline, and arms the next. */
  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    if (request.reason !== LEASE_LAPSES) return super.onDeadline(request);
    const held = this.leases.length;
    const live = liveLeases(this.leases, Date.now());
    await this.keep(live);
    if (live.length < held) await this.tellWaiters();
  }
}
