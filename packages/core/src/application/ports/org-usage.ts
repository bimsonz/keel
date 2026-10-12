import { Context, type Effect, Schema } from "effect";
import { type QuotaAdmitted, type QuotaExceeded, QuotaKind } from "../../domain/identity/index.ts";
import type { OrgId } from "../../domain/kernel/index.ts";

/**
 * An org's own quota settings, kept beside its counts: the limits that take
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
 * An org's usage against its quotas: one count per
 * kind, serialised per org, and the org's own settings. `admit` and `record`
 * are idempotent by `key`: a repeat answers what the first call answered and
 * counts nothing, for at least seven days (retries happen within minutes). A
 * key belongs to its org, its kind and its method: the same string elsewhere
 * is another key.
 */
export class OrgUsage extends Context.Service<
  OrgUsage,
  {
    /**
     * Admits `amount` more of `kind` and counts it, in one step: the decision
     * is the domain's `admitQuota` on the org's count in the current window,
     * under the org's settings as they stand (its own limit before the
     * instance's; a halted org's spend kinds refused). A refusal counts
     * nothing.
     */
    readonly admit: (
      org: OrgId,
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
      org: OrgId,
      kind: QuotaKind,
      amount: number,
      key: string,
    ) => Effect.Effect<void>;
    /** The org's settings; no overrides and not halted until it is configured. */
    readonly settings: (org: OrgId) => Effect.Effect<UsageSettings>;
    /**
     * Replaces the org's settings whole; every admission after it is decided
     * under them. What was counted, and what a key was already answered,
     * stays. A limit that is negative or not finite is a defect.
     */
    readonly configure: (org: OrgId, settings: UsageSettings) => Effect.Effect<void>;
  }
>()("keel/OrgUsage") {}
