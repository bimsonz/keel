import { Effect, Result, Schema } from "effect";
import {
  admitQuota,
  type QuotaAdmitted,
  QuotaExceeded,
  type QuotaKind,
  resetAt,
} from "../../domain/identity/index.ts";
import { type Instant, InstantSchema, OrgId } from "../../domain/kernel/index.ts";
import { Clock, EntityStore, UsageSettings } from "../ports/index.ts";

/** The EntityStore kind holding an org's count of one quota kind, keyed `<org>/<kind>`. */
const COUNT = "usage-count";
/** The EntityStore kind holding what a key was first answered, keyed `<org>/<kind>/<admit|record>/<key>`: a key is its org's, its kind's and its method's. */
const KEY = "usage-key";

/** The EntityStore kind holding an org's own settings, keyed by the org. */
const SETTINGS = "usage-settings";

/** How long a key is remembered: a repeat within it answers as the first call did. */
export const USAGE_KEY_TTL_MS = 7 * 86_400_000;

const Count = Schema.Struct({ used: Schema.Number, resetsAt: Schema.optional(InstantSchema) });
const Keyed = Schema.Struct({
  at: InstantSchema,
  admitted: Schema.optional(Schema.Struct({ limit: Schema.Number, remaining: Schema.Number })),
  exceeded: Schema.optional(QuotaExceeded),
});
const decodeCount = Schema.decodeUnknownSync(Schema.toCodecJson(Count));
const encodeCount = Schema.encodeSync(Schema.toCodecJson(Count));
const decodeKeyed = Schema.decodeUnknownSync(Schema.toCodecJson(Keyed));
const encodeKeyed = Schema.encodeSync(Schema.toCodecJson(Keyed));

const decodeSettings = Schema.decodeUnknownSync(Schema.toCodecJson(UsageSettings));
const encodeSettings = Schema.encodeSync(Schema.toCodecJson(UsageSettings));

type Store = (typeof EntityStore)["Service"];

/** An org with no settings of its own: the instance's limits, and nothing stopped. */
const UNSET: UsageSettings = { overrides: {}, halted: false };

const settingsOf = (store: Store, org: OrgId): UsageSettings => {
  const stored = store.get(SETTINGS, org);
  return stored === undefined ? UNSET : decodeSettings(stored);
};

const ADDRESS = "usage:";
const isOrg = Schema.is(OrgId);

/** Where an org's usage object lives: `usage:<orgId>`. */
export const usageAddress = (org: OrgId): string => `${ADDRESS}${org}`;

/** The org a usage object counts for, from its address; any other name throws. */
export const usageOrg = (address: string | undefined): OrgId => {
  const org = address?.startsWith(ADDRESS) ? address.slice(ADDRESS.length) : undefined;
  if (!isOrg(org)) throw new Error("an org's usage object is addressed as usage:<orgId>");
  return org;
};

/** Where an org's count of one kind is kept. */
const countId = (org: OrgId, kind: QuotaKind): string => `${org}/${kind}`;

/** The org's count of `kind` in the window `now` falls in: a daily kind counted before its reset is zero again. */
const usedAt = (store: Store, org: OrgId, kind: QuotaKind, now: Instant): number => {
  const stored = store.get(COUNT, countId(org, kind));
  if (stored === undefined) return 0;
  const count = decodeCount(stored);
  return count.resetsAt !== undefined && now >= count.resetsAt ? 0 : count.used;
};

const putUsed = (store: Store, org: OrgId, kind: QuotaKind, used: number, now: Instant): void => {
  const resetsAt = resetAt(kind, now);
  store.put(
    COUNT,
    countId(org, kind),
    encodeCount({ used, ...(resetsAt === undefined ? {} : { resetsAt }) }),
  );
};

/**
 * `OrgUsage.admit` over this object's own store: the key's first answer if it
 * has one; otherwise the domain's decision on the org's count now under the
 * org's settings, the amount counted when it is admitted, and the answer kept
 * under the key, all in one transaction, so no other admission interleaves.
 * The org's own limit comes before the instance's default, and a halted org's
 * spend kinds are refused.
 */
export const admitUsage = Effect.fn("identity/admitUsage")(function* (
  org: OrgId,
  kind: QuotaKind,
  amount: number,
  key: string,
) {
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  const answer = store.transaction((): Result.Result<QuotaAdmitted, QuotaExceeded> => {
    const id = `${org}/${kind}/admit/${key}`;
    const first = store.get(KEY, id);
    if (first !== undefined) {
      const keyed = decodeKeyed(first);
      if (keyed.exceeded !== undefined) return Result.fail(keyed.exceeded);
      if (keyed.admitted !== undefined) return Result.succeed(keyed.admitted);
    }
    const used = usedAt(store, org, kind, now);
    const { overrides, halted } = settingsOf(store, org);
    const decided = admitQuota({ kind, amount, used, now, overrides, halted });
    if (Result.isSuccess(decided)) putUsed(store, org, kind, used + amount, now);
    store.put(
      KEY,
      id,
      encodeKeyed(
        Result.isSuccess(decided)
          ? { at: now, admitted: decided.success }
          : { at: now, exceeded: decided.failure },
      ),
    );
    return decided;
  });
  return yield* Result.isSuccess(answer)
    ? Effect.succeed(answer.success)
    : Effect.fail(answer.failure);
});

/**
 * `OrgUsage.record` over this object's own store: counts the amount once per
 * key and never refuses. A negative amount gives back, and a count never
 * falls below zero: more given back than was counted leaves nothing, not
 * credit. An amount that is not a finite number is a defect.
 */
export const recordUsage = Effect.fn("identity/recordUsage")(function* (
  org: OrgId,
  kind: QuotaKind,
  amount: number,
  key: string,
) {
  if (!Number.isFinite(amount))
    yield* Effect.die(new Error(`usage of ${kind} recorded as ${amount}`));
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  store.transaction(() => {
    const id = `${org}/${kind}/record/${key}`;
    if (store.get(KEY, id) !== undefined) return;
    putUsed(store, org, kind, Math.max(0, usedAt(store, org, kind, now) + amount), now);
    store.put(KEY, id, encodeKeyed({ at: now }));
  });
});

/** Forgets every key first answered `USAGE_KEY_TTL_MS` ago or longer; answers how many it forgot and how many it still holds. */
export const pruneUsageKeys = Effect.fn("identity/pruneUsageKeys")(function* () {
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  return store.transaction(() => {
    const held = store.list(KEY);
    const old = held.filter(({ value }) => decodeKeyed(value).at + USAGE_KEY_TTL_MS <= now);
    for (const { id } of old) store.remove(KEY, id);
    return { forgotten: old.length, kept: held.length - old.length };
  });
});

/** `OrgUsage.settings` over this object's own store: the org's settings, or none of its own. */
export const usageSettings = Effect.fn("identity/usageSettings")(function* (org: OrgId) {
  return settingsOf(yield* EntityStore, org);
});

/**
 * `OrgUsage.configure` over this object's own store: replaces the org's
 * settings whole. Encoding them checks them: a limit below zero or not
 * finite throws there, a defect, and what was stored stays.
 */
export const configureUsage = Effect.fn("identity/configureUsage")(function* (
  org: OrgId,
  settings: UsageSettings,
) {
  const store = yield* EntityStore;
  yield* Effect.sync(() => store.put(SETTINGS, org, encodeSettings(settings)));
});
