import { QuotaExceeded, QuotaKind } from "@keeltown/core/domain/identity";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

/** One count against the namespace's quota: an amount of a kind, under the key that makes a repeat a no-op. */
export const UsageCount = Schema.Struct({
  kind: QuotaKind,
  amount: Schema.Number,
  key: Schema.NonEmptyString,
});
export type UsageCount = typeof UsageCount.Type;

/**
 * The NamespaceUsage port's settings, by shape (rule R15): the namespace's own limits,
 * each a finite number of zero or more, and whether its verification spend is
 * stopped.
 */
export const NamespaceUsageSettings = Schema.Struct({
  overrides: Schema.Record(
    QuotaKind,
    Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  halted: Schema.Boolean,
});
export type NamespaceUsageSettings = typeof NamespaceUsageSettings.Type;

export const NamespaceUsageCodecs = {
  admit: exitCodec(
    Schema.Struct({ limit: Schema.Number, remaining: Schema.Number }),
    QuotaExceeded,
  ),
  record: exitCodec(Schema.Void, Schema.Never),
  settings: exitCodec(NamespaceUsageSettings, Schema.Never),
  configure: exitCodec(Schema.Void, Schema.Never),
};

/**
 * The NamespaceUsage DO (`usage:<namespaceId>`): one namespace's counts against its quotas, the
 * keys that make each count idempotent, and the namespace's own settings. The namespace
 * is the object's name, never a parameter, so one object serialises one namespace's
 * admissions.
 */
export interface NamespaceUsageRpc {
  /** Admits the amount and counts it in one step, or refuses it and counts nothing. Idempotent by `key`. */
  admit(count: UsageCount): Promise<ExitJson>;
  /** Counts what already happened and never refuses; a negative amount gives back. Idempotent by `key`. */
  record(count: UsageCount): Promise<ExitJson>;
  settings(): Promise<ExitJson>;
  /** Replaces the namespace's settings whole; every admission after it is decided under them. */
  configure(settings: NamespaceUsageSettings): Promise<ExitJson>;
}
