import { Context, type Effect, Schema } from "effect";
import { type QuotaAdmitted, type QuotaExceeded, QuotaKind } from "../../domain/identity/index.ts";
import type { NamespaceId } from "../../domain/kernel/index.ts";

/**
 * A namespace's own quota settings, kept beside its counts: the limits that take
 * precedence over the instance's for the kinds they name, and whether its
 * verification spend is stopped. A limit is a finite number, zero or more.
 */
export const UsageSettings = Schema.Struct({
  overrides: Schema.Record(
    QuotaKind,
    Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  halted: Schema.Boolean,
});
export type UsageSettings = typeof UsageSettings.Type;

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
     * nothing.
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
    /** The namespace's settings; no overrides and not halted until it is configured. */
    readonly settings: (namespace: NamespaceId) => Effect.Effect<UsageSettings>;
    /**
     * Replaces the namespace's settings whole; every admission after it is decided
     * under them. What was counted, and what a key was already answered,
     * stays. A limit that is negative or not finite is a defect.
     */
    readonly configure: (namespace: NamespaceId, settings: UsageSettings) => Effect.Effect<void>;
  }
>()("keel/NamespaceUsage") {}
