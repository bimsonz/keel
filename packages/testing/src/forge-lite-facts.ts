/**
 * The parsed facts of forge-lite's S-1 trees: what a `SourceFacts` adapter must
 * report for each of the eight changes spike S17b made to the fixture, and what
 * effect derivation must then say. F01, F02, F03 and F07 are the real patches
 * under `fixtures/forge-lite/scenarios`; F04, F05, F06 and F08 are the spike's
 * own diffs on the same code. The files read are `src/authz/cache.ts`,
 * `src/authz/require-permission.ts` and, for F08, `src/routes/repos.ts`.
 *
 * Transcribed by hand from those trees. The rules an adapter follows to match:
 * - a symbol is named as an anchor names it (`RoleCache.get`, `RoleCache.#roles`,
 *   `callerRole.memo` for a local, `roleCacheFor~collaborator.removed` for a
 *   handler written inline where it is registered);
 * - a call inside an unnamed function belongs to the named symbol around it;
 * - only calls that lead to a store access are reported, each once;
 * - iterating a store is a read with no key;
 * - a key's parts are the identifier paths it is built from, read through local
 *   bindings and a key helper's arguments, with `?.` written as `.`.
 */
import {
  type Call,
  type KeyedStore,
  type SourceFacts,
  type StoreAccess,
  type SubjectAnchors,
  SubjectKey,
  type Subscription,
  type SymbolRef,
} from "@keeltown/core/domain/coordination";
import { CommitSha } from "@keeltown/core/kernel";
import { Schema } from "effect";

const commit = (digit: string) => Schema.decodeUnknownSync(CommitSha)(digit.repeat(40));

const CACHE = "src/authz/cache.ts";
const GUARD = "src/authz/require-permission.ts";
const REPOS = "src/routes/repos.ts";
const at = (path: string, symbol: string): SymbolRef => ({ path, symbol });

const requirePermission = at(GUARD, "requirePermission");
const callerRole = at(GUARD, "callerRole");
const roleCacheFor = at(CACHE, "roleCacheFor");
const cacheGet = at(CACHE, "RoleCache.get");
const cacheSet = at(CACHE, "RoleCache.set");
const cacheEvict = at(CACHE, "RoleCache.evict");
const caches = at(CACHE, "caches");
const onRemoved = at(CACHE, "roleCacheFor~collaborator.removed");

const call = (from: SymbolRef, to: SymbolRef): Call => ({ from, to, deferred: false });
const access = (
  store: SymbolRef,
  inside: SymbolRef,
  op: StoreAccess["op"],
  key: readonly string[],
  extra: Partial<StoreAccess> = {},
): StoreAccess => ({ store, in: inside, op, key, deferred: false, ...extra });

/** The WeakMap that gives each store its one RoleCache: attached state, in every tree with a cache. */
const perStore: {
  readonly stores: readonly KeyedStore[];
  readonly accesses: readonly StoreAccess[];
} = {
  stores: [{ at: caches, holder: "module", weak: true }],
  accesses: [
    access(caches, roleCacheFor, "read", ["store"]),
    access(caches, roleCacheFor, "write", ["store"]),
  ],
};
/** How `requirePermission` reaches the cache, the same in every tree that has one. */
const throughTheCache: readonly Call[] = [
  call(requirePermission, callerRole),
  call(callerRole, roleCacheFor),
  call(callerRole, cacheGet),
  call(callerRole, cacheSet),
];

type Tree = Omit<SourceFacts, "commit">;
const NOTHING: Tree = { stores: [], accesses: [], calls: [], subscriptions: [], impurities: [] };

/** A role cache keyed by (session, repository) in the map `field`, with `more` on top. */
const roleCache = (
  field: string,
  key: readonly string[],
  more: {
    readonly write?: Partial<StoreAccess>;
    readonly accesses?: (roles: SymbolRef) => readonly StoreAccess[];
    readonly calls?: readonly Call[];
    readonly subscriptions?: readonly Subscription[];
  } = {},
): Tree => {
  const roles = at(CACHE, `RoleCache.${field}`);
  return {
    stores: [{ at: roles, holder: "instance", weak: false }, ...perStore.stores],
    accesses: [
      access(roles, cacheGet, "read", key),
      access(roles, cacheSet, "write", key, more.write),
      ...(more.accesses?.(roles) ?? []),
      ...perStore.accesses,
    ],
    calls: [...throughTheCache, ...(more.calls ?? [])],
    subscriptions: more.subscriptions ?? [],
    impurities: [],
  };
};
/** `evict` walks the map and deletes the revoked collaborator's entries. */
const eviction = (roles: SymbolRef): readonly StoreAccess[] => [
  access(roles, cacheEvict, "read", []),
  access(roles, cacheEvict, "evict", ["entryKey"]),
];

/** B: per-session, never invalidated. */
const B = roleCache("#roles", ["sessionId", "repoId"]);
/** B′: the same cache, evicted in the handler of `collaborator.removed`. */
const B_REVISED = roleCache("#entries", ["sessionId", "repoId"], {
  accesses: eviction,
  calls: [call(onRemoved, cacheEvict)],
  subscriptions: [
    {
      event: "collaborator.removed",
      via: "subscribe",
      in: roleCacheFor,
      handler: onRemoved,
      async: false,
    },
  ],
});

const memo = at(GUARD, "callerRole.memo");
const ownerCache = at(REPOS, "ownerCache");
const view = at(REPOS, "view");

export type ForgeLiteItem = {
  readonly id: `F0${number}`;
  readonly what: string;
  /** The patches or the spike diff that make `head` from `base`, for an adapter's contract. */
  readonly change: string;
  readonly base: SourceFacts;
  readonly head: SourceFacts;
  /** The freshness values derivation must put on `authz.permission-evaluation`, written `is <value>`. */
  readonly derives: readonly string[];
};

const item = (
  id: ForgeLiteItem["id"],
  what: string,
  change: string,
  base: Tree,
  head: Tree,
  derives: readonly string[],
): ForgeLiteItem => ({
  id,
  what,
  change,
  base: { commit: commit("b"), ...base },
  head: { commit: commit("c"), ...head },
  derives,
});

/** The subject S-1 turns on, anchored where agent A's premise anchors it. */
export const FORGE_LITE_SUBJECT = Schema.decodeUnknownSync(SubjectKey)(
  "authz.permission-evaluation",
);
export const FORGE_LITE_SUBJECTS: readonly SubjectAnchors[] = [
  {
    subject: FORGE_LITE_SUBJECT,
    anchors: [{ path: GUARD, symbol: "requirePermission", commit: commit("a") }],
  },
];

export const FORGE_LITE_ITEMS: readonly ForgeLiteItem[] = [
  item(
    "F01",
    "B: a role cache keyed by (session, repository), never invalidated",
    "scenarios/s1/b.patch on the base fixture",
    NOTHING,
    B,
    ["per-session"],
  ),
  item(
    "F02",
    "careless: the subscription and evict() are removed",
    "scenarios/s2/careless.patch on base + A + B + B′",
    B_REVISED,
    B,
    ["per-session"],
  ),
  item(
    "F03",
    "B′: the cache evicts on collaborator.removed",
    "scenarios/s1/b-revised.patch on base + A + B",
    B,
    B_REVISED,
    ["per-session invalidated-on collaborator.removed"],
  ),
  item(
    "F04",
    "a role cache keyed by (user, repository), each entry expiring after 60 s",
    "spikes/17b-clef-scale/dataset/forge-lite/diffs/F04.diff on the base fixture",
    NOTHING,
    roleCache("#entries", ["userId", "repoId"], { write: { expiry: { seconds: 60 } } }),
    ["ttl:60"],
  ),
  item(
    "F05",
    "a role memo held on the request's context",
    "spikes/17b-clef-scale/dataset/forge-lite/diffs/F05.diff on the base fixture",
    NOTHING,
    {
      stores: [{ at: memo, holder: "request", weak: false }],
      accesses: [
        access(memo, callerRole, "read", ["repo.id"]),
        access(memo, callerRole, "write", ["repo.id"]),
      ],
      calls: [call(requirePermission, callerRole)],
      subscriptions: [],
      impurities: [],
    },
    ["per-request"],
  ),
  item(
    "F06",
    "careless again: the subscription is dropped and evict() is left defined, never called",
    "spikes/17b-clef-scale/dataset/forge-lite/diffs/F06.diff on base + A + B + B′",
    B_REVISED,
    roleCache("#entries", ["sessionId", "repoId"], { accesses: eviction }),
    ["per-session"],
  ),
  item(
    "F07",
    "A: the revoke route; requirePermission is untouched",
    "scenarios/s1/a.patch on the base fixture",
    NOTHING,
    NOTHING,
    [],
  ),
  item(
    "F08",
    "the sibling decoy: a per-session cache of a repository's owner, read by the repo view",
    "spikes/17b-clef-scale/dataset/forge-lite/diffs/F08.diff on the base fixture",
    NOTHING,
    {
      stores: [{ at: ownerCache, holder: "module", weak: false }],
      accesses: [
        access(ownerCache, view, "read", ["c.var.session.id", "repo.ownerId"]),
        access(ownerCache, view, "write", ["c.var.session.id", "repo.ownerId"]),
      ],
      calls: [call(at(REPOS, "repoRoutes"), view)],
      subscriptions: [],
      impurities: [],
    },
    [],
  ),
];
