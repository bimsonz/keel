import { Effect, Result, Schema } from "effect";
import {
  admitQuota,
  type QuotaAdmitted,
  QuotaExceeded,
  type QuotaKind,
  resetAt,
} from "../../domain/identity/index.ts";
import { type Instant, InstantSchema, NamespaceId } from "../../domain/kernel/index.ts";
import {
  Clock,
  EntityStore,
  InstanceQuotas,
  type InstanceQuotasConfig,
  UsageSettings,
} from "../ports/index.ts";

/** The EntityStore kind holding a namespace's count of one quota kind, keyed `<namespace>/<kind>`. */
const COUNT = "usage-count";
/** The EntityStore kind holding what a key was first answered, keyed `<namespace>/<kind>/<admit|record>/<key>`: a key is its namespace's, its kind's and its method's. */
const KEY = "usage-key";

/** The EntityStore kind holding a namespace's own settings, keyed by the namespace. */
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

/** A namespace with no settings of its own: the instance's limits, and nothing stopped. */
const UNSET: UsageSettings = { overrides: {}, halted: false };

/**
 * The namespace's settings as they apply: its own limits before the instance's
 * for it, and those before the instance's defaults, kind by kind; halted when
 * it is stored halted or the instance lists it. What is stored stays the
 * namespace's own.
 */
const settingsOf = (
  store: Store,
  namespace: NamespaceId,
  instance: InstanceQuotasConfig,
): UsageSettings => {
  const stored = store.get(SETTINGS, namespace);
  const own = stored === undefined ? UNSET : decodeSettings(stored);
  return {
    overrides: { ...instance.defaults, ...instance.namespaces?.[namespace], ...own.overrides },
    halted: own.halted || (instance.halted?.includes(namespace) ?? false),
  };
};

const ADDRESS = "usage:";
const isNamespace = Schema.is(NamespaceId);

/** Where a namespace's usage object lives: `usage:<namespaceId>`. */
export const usageAddress = (namespace: NamespaceId): string => `${ADDRESS}${namespace}`;

/** The namespace a usage object counts for, from its address; any other name throws. */
export const usageNamespace = (address: string | undefined): NamespaceId => {
  const namespace = address?.startsWith(ADDRESS) ? address.slice(ADDRESS.length) : undefined;
  if (!isNamespace(namespace))
    throw new Error("a namespace's usage object is addressed as usage:<namespaceId>");
  return namespace;
};

/** Where a namespace's count of one kind is kept. */
const countId = (namespace: NamespaceId, kind: QuotaKind): string => `${namespace}/${kind}`;

/** The namespace's count of `kind` in the window `now` falls in: a daily kind counted before its reset is zero again. */
const usedAt = (store: Store, namespace: NamespaceId, kind: QuotaKind, now: Instant): number => {
  const stored = store.get(COUNT, countId(namespace, kind));
  if (stored === undefined) return 0;
  const count = decodeCount(stored);
  return count.resetsAt !== undefined && now >= count.resetsAt ? 0 : count.used;
};

const putUsed = (
  store: Store,
  namespace: NamespaceId,
  kind: QuotaKind,
  used: number,
  now: Instant,
): void => {
  const resetsAt = resetAt(kind, now);
  store.put(
    COUNT,
    countId(namespace, kind),
    encodeCount({ used, ...(resetsAt === undefined ? {} : { resetsAt }) }),
  );
};

/**
 * `NamespaceUsage.admit` over this object's own store: the key's first answer if it
 * has one (a refusal of a daily kind only until the reset it named); otherwise the
 * domain's decision on the namespace's count now under the
 * namespace's settings, the amount counted when it is admitted, and the answer kept
 * under the key, all in one transaction, so no other admission interleaves.
 * The namespace's own limit comes before the instance's for it, and that before the
 * instance's default (`settingsOf`); a halted namespace's spend kinds are refused.
 */
export const admitUsage = Effect.fn("identity/admitUsage")(function* (
  namespace: NamespaceId,
  kind: QuotaKind,
  amount: number,
  key: string,
) {
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  const instance = yield* InstanceQuotas;
  const answer = store.transaction((): Result.Result<QuotaAdmitted, QuotaExceeded> => {
    const id = `${namespace}/${kind}/admit/${key}`;
    const first = store.get(KEY, id);
    if (first !== undefined) {
      const keyed = decodeKeyed(first);
      // A refusal that named when the count starts again answers until then, and is decided again after.
      const { exceeded } = keyed;
      if (exceeded !== undefined && (exceeded.retryAt === undefined || now < exceeded.retryAt))
        return Result.fail(exceeded);
      if (keyed.admitted !== undefined) return Result.succeed(keyed.admitted);
    }
    const used = usedAt(store, namespace, kind, now);
    const { overrides, halted } = settingsOf(store, namespace, instance);
    const decided = admitQuota({ kind, amount, used, now, overrides, halted });
    if (Result.isSuccess(decided)) putUsed(store, namespace, kind, used + amount, now);
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
 * `NamespaceUsage.record` over this object's own store: counts the amount once per
 * key and never refuses. A negative amount gives back, and a count never
 * falls below zero: more given back than was counted leaves nothing, not
 * credit. An amount that is not a finite number is a defect.
 */
export const recordUsage = Effect.fn("identity/recordUsage")(function* (
  namespace: NamespaceId,
  kind: QuotaKind,
  amount: number,
  key: string,
) {
  if (!Number.isFinite(amount))
    yield* Effect.die(new Error(`usage of ${kind} recorded as ${amount}`));
  const store = yield* EntityStore;
  const now = yield* (yield* Clock).now;
  store.transaction(() => {
    const id = `${namespace}/${kind}/record/${key}`;
    if (store.get(KEY, id) !== undefined) return;
    putUsed(store, namespace, kind, Math.max(0, usedAt(store, namespace, kind, now) + amount), now);
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

/** `NamespaceUsage.settings` over this object's own store: the namespace's settings as they apply (`settingsOf`). */
export const usageSettings = Effect.fn("identity/usageSettings")(function* (
  namespace: NamespaceId,
) {
  return settingsOf(yield* EntityStore, namespace, yield* InstanceQuotas);
});

/**
 * `NamespaceUsage.configure` over this object's own store: replaces the namespace's
 * settings whole. Encoding them checks them: a limit below zero or not
 * finite throws there, a defect, and what was stored stays.
 */
export const configureUsage = Effect.fn("identity/configureUsage")(function* (
  namespace: NamespaceId,
  settings: UsageSettings,
) {
  const store = yield* EntityStore;
  yield* Effect.sync(() => store.put(SETTINGS, namespace, encodeSettings(settings)));
});
