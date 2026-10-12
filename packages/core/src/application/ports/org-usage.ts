import { Context, type Effect } from "effect";
import type { QuotaAdmitted, QuotaExceeded, QuotaKind } from "../../domain/identity/index.ts";
import type { OrgId } from "../../domain/kernel/index.ts";

/**
 * An org's usage against its quotas: one count per
 * kind, serialised per org. Both methods are idempotent by `key`: a repeat
 * answers what the first call answered and counts nothing, for at least seven
 * days (retries happen within minutes). A key belongs to its org, its kind
 * and its method: the same string elsewhere is another key.
 */
export class OrgUsage extends Context.Service<
  OrgUsage,
  {
    /**
     * Admits `amount` more of `kind` and counts it, in one step: the decision
     * is the domain's `admitQuota` on the org's count in the current window.
     * A refusal counts nothing.
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
  }
>()("keel/OrgUsage") {}
