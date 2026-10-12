/**
 * Parsed-source scenarios for effect derivation. Each `Unit` is one store with
 * its wiring, drawn from what it means (is it read through, where it lives,
 * what keys and expires its entries, whether an event evicts it, what anchors
 * it), and the oracle at the foot of the file says what derivation must
 * conclude from that meaning alone, never from the facts `factsOf` writes for it.
 */
import {
  type Call,
  type SourceFacts,
  type StoreAccess,
  type StoreHolder,
  type SubjectAnchors,
  SubjectKey,
  type Subscription,
  type SymbolRef,
} from "../../src/domain/coordination/index.ts";
import { type Anchor, CommitSha } from "../../src/domain/kernel/index.ts";
import { fc } from "../support/fast-check.ts";

export const SUBJECTS = [
  SubjectKey.make("authz.permission-evaluation"),
  // A sibling of the first, and a subject nowhere near either.
  SubjectKey.make("authz.audit-log"),
  SubjectKey.make("billing.invoices"),
] as const;

export const BASE_COMMIT = CommitSha.make("b".repeat(40));
export const HEAD_COMMIT = CommitSha.make("c".repeat(40));

/** Key parts, with whether they tie an entry to a session. */
const KEYS = [
  { parts: ["sessionId", "repoId"], session: true },
  { parts: ["c.var.session.id"], session: true },
  { parts: ["SESSION_ID", "tenant"], session: true },
  { parts: ["userId", "repoId"], session: false },
  { parts: ["sessionsCount"], session: false },
  { parts: ["obsession"], session: false },
  { parts: [], session: false },
] as const;
const EVENTS = [
  { name: "collaborator.removed", valid: true },
  { name: "role.changed", valid: true },
  { name: "CollaboratorRemoved", valid: false },
  { name: "user:deleted", valid: false },
] as const;
const VIAS = [
  { name: "subscribe", inProcess: true },
  { name: "on", inProcess: true },
  { name: "addEventListener", inProcess: true },
  { name: "enqueue", inProcess: false },
  { name: "schedule", inProcess: false },
] as const;

export type Unit = {
  readonly id: number;
  readonly holder: StoreHolder;
  readonly weak: boolean;
  /** `through`: one entry symbol reaches a read and a write. Otherwise it reaches one, or a stranger does the writing. */
  readonly wiring: "through" | "read-only" | "write-only" | "split";
  /** Calls between the entry symbol and the accessors. */
  readonly hops: 0 | 1 | 2;
  readonly deferredHop: boolean;
  readonly key: (typeof KEYS)[number];
  /** `mixed`: one write expires and another does not. */
  readonly expiry: "none" | "unknown" | "mixed" | number;
  readonly sub:
    | undefined
    | {
        readonly event: (typeof EVENTS)[number];
        readonly via: (typeof VIAS)[number];
        readonly async: boolean;
        readonly hop: 0 | 1;
        readonly deferredAt: "nowhere" | "call" | "access";
        /** What the handler ends up evicting: this store, the unit's other store, or nothing. */
        readonly target: "same" | "other" | "none";
      };
  readonly anchor: "entry" | "class" | "path" | "sibling" | "elsewhere" | "prefix" | "none";
  readonly subject: 0 | 1 | 2;
};

const subArb = fc.record({
  event: fc.constantFrom(...EVENTS),
  via: fc.constantFrom(...VIAS),
  async: fc.boolean(),
  hop: fc.constantFrom<0 | 1>(0, 1),
  deferredAt: fc.constantFrom<"nowhere" | "call" | "access">(
    "nowhere",
    "nowhere",
    "call",
    "access",
  ),
  target: fc.constantFrom<"same" | "other" | "none">("same", "same", "other", "none"),
});

export const unitArb = (id: number): fc.Arbitrary<Unit> =>
  fc.record({
    id: fc.constant(id),
    holder: fc.constantFrom<StoreHolder>(
      "module",
      "module",
      "instance",
      "instance",
      "request",
      "local",
      "unknown",
    ),
    weak: fc.constantFrom(false, false, false, true),
    wiring: fc.constantFrom<Unit["wiring"]>(
      "through",
      "through",
      "through",
      "read-only",
      "write-only",
      "split",
    ),
    hops: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
    deferredHop: fc.boolean(),
    key: fc.constantFrom(...KEYS),
    expiry: fc.constantFrom<Unit["expiry"]>("none", "none", "none", "unknown", "mixed", 60, 3600),
    sub: fc.option(subArb, { nil: undefined }),
    anchor: fc.constantFrom<Unit["anchor"]>(
      "entry",
      "entry",
      "class",
      "path",
      "sibling",
      "elsewhere",
      "prefix",
      "none",
    ),
    subject: fc.constantFrom<0 | 1 | 2>(0, 0, 1, 2),
  });

/** One to four units, each in its own file. */
export const unitsArb: fc.Arbitrary<readonly Unit[]> = fc
  .integer({ min: 1, max: 4 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, id) => unitArb(id))));

const file = (u: Unit): string => `src/u${u.id}.ts`;
const sym = (u: Unit, symbol: string): SymbolRef => ({ path: file(u), symbol });
export const storeOf = (u: Unit): SymbolRef => sym(u, `Cache${u.id}.#map`);
const otherStoreOf = (u: Unit): SymbolRef => sym(u, `Cache${u.id}.#other`);
export const entryOf = (u: Unit): SymbolRef => sym(u, `entry${u.id}`);

/** The calls from `from` to `to` through the unit's hops; each `via` names its own intermediate symbols. */
const chain = (u: Unit, from: SymbolRef, to: SymbolRef, via = "mid"): Call[] => {
  const stops = [
    from,
    ...Array.from({ length: u.hops }, (_, i) => sym(u, `${via}${u.id}_${i}`)),
    to,
  ];
  return stops.slice(1).map((next, i) => ({
    from: stops[i] ?? from,
    to: next,
    // A read is a read however late it runs: deferral must not hide a reader.
    deferred: u.deferredHop && i === 0,
  }));
};

const factsOfUnit = (u: Unit): Omit<SourceFacts, "commit"> => {
  const store = storeOf(u);
  const get = sym(u, `Cache${u.id}.get`);
  const set = sym(u, `Cache${u.id}.set`);
  const put = sym(u, `Cache${u.id}.put`);
  const evict = sym(u, `Cache${u.id}.evict`);
  const entry = entryOf(u);
  const stranger = sym(u, `stranger${u.id}`);
  const access = (
    target: SymbolRef,
    inside: SymbolRef,
    op: StoreAccess["op"],
    extra: Partial<StoreAccess> = {},
  ): StoreAccess => ({
    store: target,
    in: inside,
    op,
    key: [...u.key.parts],
    deferred: false,
    ...extra,
  });
  const reads = u.wiring !== "write-only";
  const writes = u.wiring !== "read-only";
  const writer = u.wiring === "split" ? stranger : entry;
  const writerVia = u.wiring === "split" ? "far" : "mid";
  const expiry =
    u.expiry === "none"
      ? {}
      : {
          expiry:
            u.expiry === "unknown"
              ? ("unknown" as const)
              : { seconds: u.expiry === "mixed" ? 60 : u.expiry },
        };
  const accesses: StoreAccess[] = [
    ...(reads ? [access(store, get, "read")] : []),
    ...(writes ? [access(store, set, "write", expiry)] : []),
    ...(writes && u.expiry === "mixed" ? [access(store, put, "write")] : []),
  ];
  const calls: Call[] = [
    ...(reads ? chain(u, entry, get) : []),
    // A stranger's way to the write shares no symbol with the entry's way to the read.
    ...(writes ? chain(u, writer, set, writerVia) : []),
    ...(writes && u.expiry === "mixed" ? chain(u, writer, put, writerVia) : []),
    // A sibling in the same file that only reads: never a reader.
    ...(reads ? [{ from: sym(u, `sibling${u.id}`), to: get, deferred: false }] : []),
  ];
  const subscriptions: Subscription[] = [];
  if (u.sub !== undefined) {
    const handler = sym(u, `wire${u.id}~${u.sub.event.name}`);
    const helper = sym(u, `helper${u.id}`);
    subscriptions.push({
      event: u.sub.event.name,
      via: u.sub.via.name,
      in: sym(u, `wire${u.id}`),
      handler,
      async: u.sub.async,
    });
    if (u.sub.target !== "none") {
      const deferredCall = u.sub.deferredAt === "call";
      calls.push(
        ...(u.sub.hop === 0
          ? [{ from: handler, to: evict, deferred: deferredCall }]
          : [
              { from: handler, to: helper, deferred: deferredCall },
              { from: helper, to: evict, deferred: false },
            ]),
      );
      accesses.push(
        access(u.sub.target === "same" ? store : otherStoreOf(u), evict, "evict", {
          deferred: u.sub.deferredAt === "access",
        }),
      );
    }
  }
  return {
    stores: [
      { at: store, holder: u.holder, weak: u.weak },
      { at: otherStoreOf(u), holder: "module", weak: false },
    ],
    accesses,
    calls,
    subscriptions,
  };
};

export const factsOf = (units: readonly Unit[], commit: CommitSha = HEAD_COMMIT): SourceFacts => {
  const parts = units.map(factsOfUnit);
  return {
    commit,
    stores: parts.flatMap((p) => p.stores),
    accesses: parts.flatMap((p) => p.accesses),
    calls: parts.flatMap((p) => p.calls),
    subscriptions: parts.flatMap((p) => p.subscriptions),
  };
};

/** The anchor each kind writes; `none` writes no anchor at all. */
const anchorOf = (u: Unit): Anchor | undefined => {
  const pinned = { commit: BASE_COMMIT };
  const anchors: Record<Exclude<Unit["anchor"], "none">, Anchor> = {
    entry: { path: file(u), symbol: `entry${u.id}`, ...pinned },
    class: { path: file(u), symbol: `Cache${u.id}`, ...pinned },
    path: { path: file(u), ...pinned },
    sibling: { path: file(u), symbol: `sibling${u.id}`, ...pinned },
    elsewhere: { path: "src/elsewhere.ts", symbol: `entry${u.id}`, ...pinned },
    prefix: { path: file(u), symbol: "entry", ...pinned },
  };
  return u.anchor === "none" ? undefined : anchors[u.anchor];
};

/** The registry rows the units' anchors make: one row per anchored unit. */
export const subjectsOf = (units: readonly Unit[]): readonly SubjectAnchors[] =>
  units.flatMap((u) => {
    const anchor = anchorOf(u);
    return anchor === undefined ? [] : [{ subject: SUBJECTS[u.subject], anchors: [anchor] }];
  });

// ---------------------------------------------------------------- the oracle

export const isCache = (u: Unit): boolean =>
  !u.weak && u.holder !== "local" && u.wiring === "through";

/** The bound a cache serves before any invalidation: a written value, or why it is undecided. */
export const baseOf = (
  u: Unit,
): { readonly value: string } | { readonly undecided: "holder-unknown" | "expiry-unknown" } => {
  if (u.holder === "request") return { value: "per-request" };
  if (u.holder === "unknown") return { undecided: "holder-unknown" };
  if (u.expiry === "unknown") return { undecided: "expiry-unknown" };
  if (typeof u.expiry === "number") return { value: `ttl:${u.expiry}` };
  return { value: u.key.session ? "per-session" : "static" };
};

/** The event that invalidates the unit's cache, when every condition of the edge holds. */
export const edgeOf = (u: Unit): string | undefined =>
  u.sub !== undefined &&
  u.sub.via.inProcess &&
  !u.sub.async &&
  u.sub.event.valid &&
  u.sub.deferredAt === "nowhere" &&
  u.sub.target === "same"
    ? u.sub.event.name
    : undefined;

/** What the cache claims, written as the proposition's value. */
export const claimOf = (
  u: Unit,
): { readonly value: string } | { readonly undecided: "holder-unknown" | "expiry-unknown" } => {
  const base = baseOf(u);
  const edge = edgeOf(u);
  return "undecided" in base || edge === undefined || base.value === "per-request"
    ? base
    : { value: `${base.value} invalidated-on ${edge}` };
};

/** The subjects whose anchors tie them to this unit's cache, given every anchored unit in play. */
export const subjectsFor = (u: Unit, anchored: readonly Unit[]): readonly SubjectKey[] =>
  isCache(u)
    ? [
        ...new Set(
          anchored
            .filter(
              (row) =>
                row.id === u.id &&
                (row.anchor === "entry" || row.anchor === "class" || row.anchor === "path"),
            )
            .map((row) => SUBJECTS[row.subject]),
        ),
      ]
    : [];

/** Every `subject is value` the units' caches claim, as `subject|value`, sorted. */
export const claimsOf = (units: readonly Unit[], anchored: readonly Unit[]): readonly string[] =>
  [
    ...new Set(
      units.flatMap((u) => {
        const claim = claimOf(u);
        return "value" in claim
          ? subjectsFor(u, anchored).map((subject) => `${subject}|${claim.value}`)
          : [];
      }),
    ),
  ].toSorted();

/** Every cache the rules must leave undecided on a subject, as `subject|store|reason`, sorted. */
export const undecidedOf = (units: readonly Unit[], anchored: readonly Unit[]): readonly string[] =>
  units
    .flatMap((u) => {
      const claim = claimOf(u);
      return "undecided" in claim
        ? subjectsFor(u, anchored).map(
            (subject) => `${subject}|${storeOf(u).symbol}|${claim.undecided}`,
          )
        : [];
    })
    .toSorted();
