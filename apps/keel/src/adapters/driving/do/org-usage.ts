import {
  admitUsage,
  configureUsage,
  pruneUsageKeys,
  recordUsage,
  usageOrg,
  usageSettings,
} from "@keeltown/core/application/identity";
import type { NamespaceId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import {
  OrgUsageCodecs,
  type OrgUsageRpc,
  OrgUsageSettings,
  UsageCount,
} from "../../../rpc/org-usage.ts";
import { armedAlarms, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObject } from "./keel-object.ts";

/** The object's own deadline: forget the keys first answered a week ago or longer. */
export const USAGE_PRUNE = "usage prune";
/** How long after a key is stored the prune first runs, and how often while any key is held. */
export const USAGE_PRUNE_EVERY_MS = 86_400_000;

const decodeCount = Schema.decodeUnknownEffect(UsageCount);
const decodeSettings = Schema.decodeUnknownEffect(OrgUsageSettings);

/**
 * The OrgUsage DO (`usage:<orgId>`): one org's counts against its quotas, the
 * keys that make each count idempotent, and the org's own settings (its
 * limits and whether its spend is stopped), which every admission is decided
 * under. One object per org, so the platform serialises an org's admissions:
 * no two interleave between the check and the count. It commits no event; the
 * counts are its state. Keys are forgotten a week after their first answer,
 * by `usage prune`, armed a day after a count and then daily while any key is
 * held.
 */
export class OrgUsageDO extends KeelObject implements OrgUsageRpc {
  private get org(): NamespaceId {
    return usageOrg(this.ctx.id.name);
  }

  async admit(count: unknown) {
    const org = this.org;
    const answer = await this.answer(
      OrgUsageCodecs.admit,
      decodeCount(count).pipe(
        Effect.orDie,
        Effect.flatMap(({ kind, amount, key }) => admitUsage(org, kind, amount, key)),
      ),
    );
    await this.armPrune();
    return answer;
  }

  async record(count: unknown) {
    const org = this.org;
    const answer = await this.answer(
      OrgUsageCodecs.record,
      decodeCount(count).pipe(
        Effect.orDie,
        Effect.flatMap(({ kind, amount, key }) => recordUsage(org, kind, amount, key)),
      ),
    );
    await this.armPrune();
    return answer;
  }

  async settings() {
    return this.answer(OrgUsageCodecs.settings, usageSettings(this.org));
  }

  async configure(settings: unknown) {
    const org = this.org;
    return this.answer(
      OrgUsageCodecs.configure,
      decodeSettings(settings).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => configureUsage(org, decoded)),
      ),
    );
  }

  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    if (request.reason !== USAGE_PRUNE) return super.onDeadline(request);
    const { kept } = await this.runtime.runPromise(pruneUsageKeys());
    // This run's own request is on the table until it returns, so the next is armed whatever is there.
    if (kept > 0) await this.schedulePrune();
  }

  /** Arms the prune a day from now unless it is armed already, so a burst of counts never postpones it. */
  private async armPrune(): Promise<void> {
    if (armedAlarms(this.ctx.storage).some((alarm) => alarm.reason === USAGE_PRUNE)) return;
    await this.schedulePrune();
  }

  private schedulePrune(): Promise<void> {
    return scheduleAlarm(this.ctx.storage, {
      kind: "deadline",
      reason: USAGE_PRUNE,
      at: Date.now() + USAGE_PRUNE_EVERY_MS,
    });
  }
}
