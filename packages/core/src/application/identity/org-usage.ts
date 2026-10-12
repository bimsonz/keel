import { Effect, Result, Schema } from "effect";
import {
  admitQuota,
  type QuotaAdmitted,
  QuotaExceeded,
  type QuotaKind,
  resetAt,
} from "../../domain/identity/index.ts";
import { type Instant, InstantSchema, type OrgId } from "../../domain/kernel/index.ts";
import { Clock, EntityStore } from "../ports/index.ts";

/** The EntityStore kind holding an org's count of one quota kind, keyed `<org>/<kind>`. */
const COUNT = "usage-count";
/** The EntityStore kind holding what a key was first answered, keyed `<org>/<kind>/<admit|record>/<key>`: a key is its org's, its kind's and its method's. */
const KEY = "usage-key";

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

type Store = (typeof EntityStore)["Service"];

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
 * has one; otherwise the domain's decision on the org's count now, the amount
 * counted when it is admitted, and the answer kept under the key, all in one
 * transaction, so no other admission interleaves. Limits are the instance's
 * defaults.
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
    const decided = admitQuota({ kind, amount, used, now, halted: false });
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

/** Forgets every key first answered `USAGE_KEY_TTL_MS` ago or longer; answers how many it forgot. */
export const pruneUsageKeys = Effect.fn("identity/pruneUsageKeys")(function* () {
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  return store.transaction(() => {
    const old = store
      .list(KEY)
      .filter(({ value }) => decodeKeyed(value).at + USAGE_KEY_TTL_MS <= now);
    for (const { id } of old) store.remove(KEY, id);
    return old.length;
  });
});
