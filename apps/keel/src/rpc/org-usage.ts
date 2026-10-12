import { QuotaExceeded, QuotaKind } from "@keeltown/core/domain/identity";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

/** One count against the org's quota: an amount of a kind, under the key that makes a repeat a no-op. */
export const UsageCount = Schema.Struct({
  kind: QuotaKind,
  amount: Schema.Number,
  key: Schema.NonEmptyString,
});
export type UsageCount = typeof UsageCount.Type;

/**
 * The OrgUsage port's settings, by shape (rule R15): the org's own limits,
 * each a finite number of zero or more, and whether its verification spend is
 * stopped.
 */
export const OrgUsageSettings = Schema.Struct({
  overrides: Schema.Record(
    QuotaKind,
    Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  halted: Schema.Boolean,
});
export type OrgUsageSettings = typeof OrgUsageSettings.Type;

export const OrgUsageCodecs = {
  admit: exitCodec(
    Schema.Struct({ limit: Schema.Number, remaining: Schema.Number }),
    QuotaExceeded,
  ),
  record: exitCodec(Schema.Void, Schema.Never),
  settings: exitCodec(OrgUsageSettings, Schema.Never),
  configure: exitCodec(Schema.Void, Schema.Never),
};

/**
 * The OrgUsage DO (`usage:<orgId>`): one org's counts against its quotas, the
 * keys that make each count idempotent, and the org's own settings. The org
 * is the object's name, never a parameter, so one object serialises one org's
 * admissions.
 */
export interface OrgUsageRpc {
  /** Admits the amount and counts it in one step, or refuses it and counts nothing. Idempotent by `key`. */
  admit(count: UsageCount): Promise<ExitJson>;
  /** Counts what already happened and never refuses; a negative amount gives back. Idempotent by `key`. */
  record(count: UsageCount): Promise<ExitJson>;
  settings(): Promise<ExitJson>;
  /** Replaces the org's settings whole; every admission after it is decided under them. */
  configure(settings: OrgUsageSettings): Promise<ExitJson>;
}
