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
 * namespace's: it counts keel-verify's Tier 2 boxes under their cap.
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

  /** The namespace's limit, read before the leases so no ask interleaves between their read and write. */
  private async limit(): Promise<number> {
    if (this.ctx.id.name === TIER2_GATE) return TIER2_BOX_CAP;
    const namespace = namespaceOf(this.ctx.id.name);
    const settings = await this.runtime.runPromise(
      NamespaceUsage.use((usage) => usage.settings(namespace)),
    );
    if (settings.halted) return 0;
    return settings.overrides["concurrent-containers"] ?? DEFAULT_QUOTAS["concurrent-containers"];
  }

  /** Asks for a box for `holder` for `ttlMs`; a holder with a live lease has it renewed. */
  async acquire(ask: { readonly holder: string; readonly ttlMs: number }): Promise<GateAnswer> {
    const limit = await this.limit();
    const { leases, answer } = acquireLease(
      this.leases,
      { ...ask, id: crypto.randomUUID() },
      limit,
      Date.now(),
    );
    await this.keep(leases);
    return answer;
  }

  /** Gives a lease back; one already gone, released or expired, changes nothing. */
  async release(leaseId: string): Promise<void> {
    await this.keep(releaseLease(this.leases, leaseId, Date.now()));
  }

  /** How many more leases the limit allows now, never below 0. */
  async free(): Promise<number> {
    const limit = await this.limit();
    return Math.max(0, limit - liveLeases(this.leases, Date.now()).length);
  }

  /** How many leases are live, for tests and the operator. */
  async held(): Promise<number> {
    return liveLeases(this.leases, Date.now()).length;
  }

  /** Reclaims every lease past its deadline, and arms the next. */
  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    if (request.reason !== LEASE_LAPSES) return super.onDeadline(request);
    await this.keep(liveLeases(this.leases, Date.now()));
  }
}
