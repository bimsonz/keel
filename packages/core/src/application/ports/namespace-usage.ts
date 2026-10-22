import { Context, type Effect, Schema } from "effect";
import { type QuotaAdmitted, type QuotaExceeded, QuotaKind } from "../../domain/identity/index.ts";
import { NamespaceId } from "../../domain/kernel/index.ts";

/** Limits by kind, for the kinds they name: each a finite number, zero or more. */
const Limits = Schema.Record(
  QuotaKind,
  Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
);

/**
 * A namespace's own quota settings, kept beside its counts: the limits that take
 * precedence over the instance's for the kinds they name, and whether its
 * verification spend is stopped. A limit is a finite number, zero or more.
 */
export const UsageSettings = Schema.Struct({
  overrides: Limits,
  halted: Schema.Boolean,
});
export type UsageSettings = typeof UsageSettings.Type;

/**
 * The instance's quota configuration (R9), as whoever runs it sets it: limits
 * that replace `DEFAULT_QUOTAS` for every namespace (`defaults`), limits for
 * named namespaces (`namespaces`), and the namespaces whose verification spend
 * is stopped (`halted`, the instance's kill switch). A namespace's own limits
 * come before both; a namespace listed as halted is halted whatever its own
 * settings say. Empty, every namespace has the defaults and none is halted.
 */
export const InstanceQuotasConfig = Schema.Struct({
  defaults: Schema.optionalKey(Limits),
  namespaces: Schema.optionalKey(Schema.Record(NamespaceId, Limits)),
  halted: Schema.optionalKey(Schema.Array(NamespaceId)),
});
export type InstanceQuotasConfig = typeof InstanceQuotasConfig.Type;

/** The instance's quota configuration, read where admissions are decided; none until the composition provides it. */
export const InstanceQuotas = Context.Reference<InstanceQuotasConfig>("keel/InstanceQuotas", {
  defaultValue: () => ({}),
});

/**
 * A namespace's usage against its quotas: one count per
 * kind, serialised per namespace, and the namespace's own settings. `admit` and `record`
 * are idempotent by `key`: a repeat answers what the first call answered and
 * counts nothing, for at least seven days (retries happen within minutes). A
 * key belongs to its namespace, its kind and its method: the same string elsewhere
 * is another key.
 */
export class NamespaceUsage extends Context.Service<
  NamespaceUsage,
  {
    /**
     * Admits `amount` more of `kind` and counts it, in one step: the decision
     * is the domain's `admitQuota` on the namespace's count in the current window,
     * under the namespace's settings as they stand (its own limit before the
     * instance's; a halted namespace's spend kinds refused). A refusal counts
     * nothing; a refusal of a daily kind is its key's answer only until the
     * reset it names, after which the key is decided again.
     */
    readonly admit: (
      namespace: NamespaceId,
      kind: QuotaKind,
      amount: number,
      key: string,
    ) => Effect.Effect<QuotaAdmitted, QuotaExceeded>;
    /**
     * Counts `amount` of `kind` that already happened; it never refuses. A
     * negative amount gives back what was counted (a declined promotion's
     * bytes, a failed fork's), and a count never falls below zero.
     */
    readonly record: (
      namespace: NamespaceId,
      kind: QuotaKind,
      amount: number,
      key: string,
    ) => Effect.Effect<void>;
    /**
     * The namespace's settings as they apply: its own limits, then the
     * instance's for it, then the instance's defaults, each kind from the first
     * that names it (`DEFAULT_QUOTAS` for a kind none names); halted when its
     * own settings say so or the instance's configuration lists it.
     */
    readonly settings: (namespace: NamespaceId) => Effect.Effect<UsageSettings>;
    /**
     * Replaces the namespace's settings whole; every admission after it is decided
     * under them. What was counted, and what a key was already answered,
     * stays. A limit that is negative or not finite is a defect.
     */
    readonly configure: (namespace: NamespaceId, settings: UsageSettings) => Effect.Effect<void>;
  }
>()("keel/NamespaceUsage") {}
