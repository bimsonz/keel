import {
  admitUsage,
  configureUsage,
  pruneUsageKeys,
  recordUsage,
  usageNamespace,
  usageSettings,
} from "@keeltown/core/application/identity";
import type { NamespaceId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import {
  NamespaceUsageCodecs,
  type NamespaceUsageRpc,
  NamespaceUsageSettings,
  UsageCount,
} from "../../../rpc/namespace-usage.ts";
import { namespaceUsageServices } from "../../../composition/do.ts";
import { armedAlarms, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObjectWith } from "./keel-object.ts";

/** The object's own deadline: forget the keys first answered a week ago or longer. */
export const USAGE_PRUNE = "usage prune";
/** How long after a key is stored the prune first runs, and how often while any key is held. */
export const USAGE_PRUNE_EVERY_MS = 86_400_000;

const decodeCount = Schema.decodeUnknownEffect(UsageCount);
const decodeSettings = Schema.decodeUnknownEffect(NamespaceUsageSettings);

/**
 * The NamespaceUsage DO (`usage:<namespaceId>`): one namespace's counts against its quotas, the
 * keys that make each count idempotent, and the namespace's own settings (its
 * limits and whether its spend is stopped), which every admission is decided
 * under. One object per namespace, so the platform serialises a namespace's admissions:
 * no two interleave between the check and the count. It commits no event; the
 * counts are its state. Its limits are the instance's configuration (`KEEL_QUOTAS`)
 * under the namespace's own settings. Keys are forgotten a week after their first answer,
 * by `usage prune`, armed a day after a count and then daily while any key is
 * held.
 */
export class NamespaceUsageDO extends KeelObjectWith<never> implements NamespaceUsageRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, namespaceUsageServices(env));
  }

  private get namespace(): NamespaceId {
    return usageNamespace(this.ctx.id.name);
  }

  async admit(count: unknown) {
    const namespace = this.namespace;
    const answer = await this.answer(
      NamespaceUsageCodecs.admit,
      decodeCount(count).pipe(
        Effect.orDie,
        Effect.flatMap(({ kind, amount, key }) => admitUsage(namespace, kind, amount, key)),
      ),
    );
    await this.armPrune();
    return answer;
  }

  async record(count: unknown) {
    const namespace = this.namespace;
    const answer = await this.answer(
      NamespaceUsageCodecs.record,
      decodeCount(count).pipe(
        Effect.orDie,
        Effect.flatMap(({ kind, amount, key }) => recordUsage(namespace, kind, amount, key)),
      ),
    );
    await this.armPrune();
    return answer;
  }

  async settings() {
    return this.answer(NamespaceUsageCodecs.settings, usageSettings(this.namespace));
  }

  async configure(settings: unknown) {
    const namespace = this.namespace;
    return this.answer(
      NamespaceUsageCodecs.configure,
      decodeSettings(settings).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => configureUsage(namespace, decoded)),
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
