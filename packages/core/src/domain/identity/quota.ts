import { Result, Schema } from "effect";
import { Instant, InstantSchema, NextAction } from "../kernel/index.ts";

/**
 * What an org's usage is counted in. Repo bytes count
 * trunk only; container-minutes and model calls are per UTC day.
 */
export const QuotaKind = Schema.Literals([
  "projects",
  "agents",
  "active-changes",
  "repo-bytes",
  "container-minutes",
  "model-calls",
  "concurrent-containers",
]);
export type QuotaKind = typeof QuotaKind.Type;

export type Quotas = Readonly<Record<QuotaKind, number>>;

/**
 * The instance's defaults (R9): engineering defaults the instance admin
 * adjusts live with SetQuotas, each org's overrides taking precedence.
 */
export const DEFAULT_QUOTAS: Quotas = {
  projects: 10,
  agents: 20,
  "active-changes": 50,
  "repo-bytes": 1024 ** 3,
  "container-minutes": 120,
  "model-calls": 500,
  "concurrent-containers": 2,
};

/** The kinds counted per UTC day, reset at midnight. The rest are running totals. */
export const DAILY_QUOTAS: ReadonlySet<QuotaKind> = new Set(["container-minutes", "model-calls"]);

/** The kinds that spend on verification, which the instance's kill switch stops. */
export const SPEND_QUOTAS: ReadonlySet<QuotaKind> = new Set([
  "container-minutes",
  "model-calls",
  "concurrent-containers",
]);

const DAY_MS = 86_400_000;

/** When a daily kind's count resets after `now`: the next UTC midnight. Undefined for a running total. */
export const resetAt = (kind: QuotaKind, now: Instant): Instant | undefined =>
  DAILY_QUOTAS.has(kind) ? Instant((Math.floor(now / DAY_MS) + 1) * DAY_MS) : undefined;

/** An admission to decide: `amount` more of `kind`, on top of the org's `used` in the current window. */
export interface QuotaAsk {
  readonly kind: QuotaKind;
  readonly amount: number;
  readonly used: number;
  readonly now: Instant;
  /** The instance's limits, as the admin set them; `DEFAULT_QUOTAS` when absent. */
  readonly defaults?: Quotas;
  /** The org's own limits, which take precedence. */
  readonly overrides?: Partial<Quotas>;
  /** Whether the instance admin has stopped new verification spend. */
  readonly halted: boolean;
}

export interface QuotaAdmitted {
  readonly limit: number;
  readonly remaining: number;
}

/**
 * An admission refused: over the org's limit (`limit`), or the instance's
 * verification spend is stopped (`halted`). A daily kind says when it resets.
 */
export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()("QuotaExceeded", {
  kind: QuotaKind,
  reason: Schema.Literals(["limit", "halted"]),
  limit: Schema.Number,
  used: Schema.Number,
  requested: Schema.Number,
  retryAt: Schema.optional(InstantSchema),
  nextActions: Schema.Array(NextAction),
}) {}

/** The limit an org has for `kind`: its override, else the instance's. */
export const quotaLimit = (
  kind: QuotaKind,
  defaults: Quotas = DEFAULT_QUOTAS,
  overrides: Partial<Quotas> = {},
): number => overrides[kind] ?? defaults[kind];

/**
 * Admits `amount` more of a kind, or refuses it with next actions. Admitted
 * exactly when the total stays within the limit; an amount or a count that is
 * negative or not finite is refused. The OrgUsage port serialises an org's
 * admissions and keeps its counts; this decides.
 */
export const admitQuota = (ask: QuotaAsk): Result.Result<QuotaAdmitted, QuotaExceeded> => {
  const limit = quotaLimit(ask.kind, ask.defaults, ask.overrides);
  const refusal = { kind: ask.kind, limit, used: ask.used, requested: ask.amount };
  if (ask.halted && SPEND_QUOTAS.has(ask.kind))
    return Result.fail(
      new QuotaExceeded({
        ...refusal,
        reason: "halted",
        nextActions: [
          { kind: "escalate", title: "Verification spend is stopped; ask the instance admin" },
        ],
      }),
    );
  const sane = Number.isFinite(ask.amount) && ask.amount >= 0 && ask.used >= 0;
  const total = ask.used + ask.amount;
  if (sane && total <= limit) return Result.succeed({ limit, remaining: limit - total });
  const retryAt = resetAt(ask.kind, ask.now);
  return Result.fail(
    new QuotaExceeded({
      ...refusal,
      reason: "limit",
      ...(retryAt === undefined ? {} : { retryAt }),
      nextActions: [
        retryAt === undefined
          ? {
              kind: "escalate",
              title: `The org is at its ${ask.kind} limit (${limit}); free some, or ask the instance admin to raise it`,
            }
          : {
              kind: "wait",
              title: `The org has used its ${ask.kind} for today (${limit}); it resets at UTC midnight`,
              args: { retryAt },
            },
      ],
    }),
  );
};
