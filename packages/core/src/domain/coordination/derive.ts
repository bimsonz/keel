/**
 * Deterministic effect derivation: what a change does to the freshness of the
 * subjects its code serves, read from the parsed facts of its base and head
 * trees. An effect found here is a ruling, a judgement over the code that
 * executes nothing, and never proof.
 */
import { Schema } from "effect";
import type { Anchor } from "../kernel/index.ts";
import type { Intent } from "./change.ts";
import { writeProposition } from "./claim.ts";
import type { ExtractedEffect } from "./derivation.ts";
import { isDeclared } from "./drift.ts";
import type { Freshness, FreshnessValue } from "./lattice.ts";
import { SubjectKey } from "./proposition.ts";
import type { SourceFacts, SymbolRef } from "./syntax.ts";

/** A subject and the code it is anchored to: the only way a subject is attributed. */
export type SubjectAnchors = {
  readonly subject: SubjectKey;
  readonly anchors: readonly Anchor[];
};

/**
 * The names the default rules read. Keel's set is a default, never a rule: a
 * project composes its own (ADR 0005).
 */
export type Vocabulary = {
  /** A key part naming one of these words ties an entry to a session. */
  readonly sessionWords: readonly string[];
  /** Methods that register a handler an in-process bus calls in the event's own turn. */
  readonly registrars: readonly string[];
};
export const DEFAULT_VOCABULARY: Vocabulary = {
  sessionWords: ["session"],
  registrars: ["subscribe", "on", "addListener", "addEventListener"],
};

export type UndecidedReason = "holder-unknown" | "expiry-unknown";

/**
 * A cache the facts hold: a store some symbol reads through, with how stale it
 * can serve, or why the rules cannot say.
 */
export type StoreClaim = {
  readonly store: SymbolRef;
  /** The symbols that read through it: each reaches a read and a write of it by calls. */
  readonly readers: readonly SymbolRef[];
  /** Where each subscription that invalidates it is registered. */
  readonly subscribedIn: readonly SymbolRef[];
} & ({ readonly freshness: FreshnessValue } | { readonly undecided: UndecidedReason });

/** A cache serving a subject that the rules could not decide: the decision model is asked about exactly these. */
export type Undecided = {
  readonly subject: SubjectKey;
  readonly store: SymbolRef;
  readonly reason: UndecidedReason;
};

export type Derivation = {
  readonly effects: readonly ExtractedEffect[];
  readonly undecided: readonly Undecided[];
};

const refKey = (r: SymbolRef): string => `${r.path}\n${r.symbol}`;
const byRef = (a: SymbolRef, b: SymbolRef): number =>
  refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0;
const uniqueRefs = (refs: readonly SymbolRef[]): SymbolRef[] =>
  [...new Map(refs.map((r) => [refKey(r), r])).values()].toSorted(byRef);

type Edge = { readonly to: string; readonly deferred: boolean };

/** Every symbol that reaches one of `targets` by calls, the targets included. */
const reaching = (
  calledBy: ReadonlyMap<string, readonly string[]>,
  targets: ReadonlySet<string>,
): ReadonlySet<string> => {
  const seen = new Set(targets);
  const queue = [...targets];
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const caller of calledBy.get(next) ?? [])
      if (!seen.has(caller)) {
        seen.add(caller);
        queue.push(caller);
      }
  return seen;
};

/** Every symbol `start` reaches without a deferred call, itself included. */
const reachedAtOnce = (calls: ReadonlyMap<string, readonly Edge[]>, start: string): Set<string> => {
  const seen = new Set([start]);
  const queue = [start];
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const edge of calls.get(next) ?? [])
      if (!edge.deferred && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
  return seen;
};

const wordsOf = (part: string): readonly string[] =>
  part
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase());

const isEventKey = Schema.is(SubjectKey);

/**
 * The caches in a tree and how stale each can serve.
 *
 * A cache is a store read through: some symbol reaches both a read and a
 * write of it. A store that is only read (a table, a primary store) or that
 * holds its keys weakly (state attached to an object) claims nothing.
 *
 * Its freshness is bounded by where it lives and what its entries are keyed
 * by: nothing in a function body; per-request on the request's context; a TTL
 * when every write carries a literal expiry; per-session when every write's
 * key names a session; otherwise static. An expiry or a holder the parser
 * could not read leaves it undecided.
 *
 * It is "invalidated on E" only when a handler registered for E on an
 * in-process bus, itself not async, reaches a removal on this same store with
 * no deferred call or access on the way. Anything less is the plain bound.
 */
export const storeClaims = (
  facts: SourceFacts,
  vocabulary: Vocabulary = DEFAULT_VOCABULARY,
): readonly StoreClaim[] => {
  const calledBy = new Map<string, string[]>();
  const calls = new Map<string, Edge[]>();
  const refs = new Map<string, SymbolRef>();
  for (const call of facts.calls) {
    const from = refKey(call.from);
    const to = refKey(call.to);
    refs.set(from, call.from).set(to, call.to);
    calledBy.set(to, [...(calledBy.get(to) ?? []), from]);
    calls.set(from, [...(calls.get(from) ?? []), { to, deferred: call.deferred }]);
  }
  for (const access of facts.accesses) refs.set(refKey(access.in), access.in);
  const sessionWords = new Set(vocabulary.sessionWords.map((word) => word.toLowerCase()));

  const stores = [...new Map(facts.stores.map((s) => [refKey(s.at), s])).values()].toSorted(
    (a, b) => byRef(a.at, b.at),
  );
  return stores.flatMap((store): StoreClaim[] => {
    if (store.weak || store.holder === "local") return [];
    const accesses = facts.accesses.filter((a) => refKey(a.store) === refKey(store.at));
    const doing = (op: "read" | "write"): ReadonlySet<string> =>
      new Set(accesses.filter((a) => a.op === op).map((a) => refKey(a.in)));
    const reads = reaching(calledBy, doing("read"));
    const writers = reaching(calledBy, doing("write"));
    const readers = uniqueRefs(
      [...reads].filter((key) => writers.has(key)).flatMap((key) => refs.get(key) ?? []),
    );
    if (readers.length === 0) return [];

    const writes = accesses.filter((a) => a.op === "write");
    const evictedIn = new Set(
      accesses.filter((a) => a.op === "evict" && !a.deferred).map((a) => refKey(a.in)),
    );
    const invalidating = facts.subscriptions.filter(
      (s) =>
        vocabulary.registrars.includes(s.via) &&
        !s.async &&
        isEventKey(s.event) &&
        [...reachedAtOnce(calls, refKey(s.handler))].some((key) => evictedIn.has(key)),
    );
    const invalidatedOn = [...new Set(invalidating.map((s) => s.event))].toSorted();
    const claim = { store: store.at, readers, subscribedIn: [] };
    // A request's own memo is already as fresh as an eviction would make it.
    const decided = (cached: Freshness): StoreClaim[] => [
      invalidatedOn.length === 0 || cached === "per-request"
        ? { ...claim, freshness: cached }
        : {
            ...claim,
            subscribedIn: uniqueRefs(invalidating.map((s) => s.in)),
            freshness: { cached, invalidatedOn },
          },
    ];

    if (store.holder === "request") return decided("per-request");
    if (store.holder === "unknown") return [{ ...claim, undecided: "holder-unknown" }];
    if (writes.some((w) => w.expiry === "unknown"))
      return [{ ...claim, undecided: "expiry-unknown" }];
    const expiries = writes.flatMap((w) =>
      w.expiry === undefined || w.expiry === "unknown" ? [] : [w.expiry.seconds],
    );
    if (expiries.length === writes.length) return decided({ ttl: Math.max(...expiries) });
    const sessionKeyed = writes.every((w) =>
      w.key.some((part) => wordsOf(part).some((word) => sessionWords.has(word))),
    );
    return decided(sessionKeyed ? "per-session" : "static");
  });
};

/** An anchor covers a symbol in its file when it names it, names its class, or names no symbol at all. */
const covers = (anchor: Anchor, ref: SymbolRef): boolean =>
  anchor.path === ref.path &&
  (anchor.symbol === undefined ||
    anchor.symbol === ref.symbol ||
    ref.symbol.startsWith(`${anchor.symbol}.`));

type Attributed = {
  readonly subject: SubjectKey;
  readonly claim: StoreClaim;
  /** What ties the cache to the subject: the anchored readers, and the store when it is anchored itself. */
  readonly covered: readonly SymbolRef[];
};

/**
 * Puts each cache on the subjects whose anchors cover one of its readers or
 * the store itself. Never by a name, a shared file alone, or a nearby subject.
 */
const attribute = (
  claims: readonly StoreClaim[],
  subjects: readonly SubjectAnchors[],
): readonly Attributed[] => {
  const anchorsOf = new Map<SubjectKey, Anchor[]>();
  for (const row of subjects)
    anchorsOf.set(row.subject, [...(anchorsOf.get(row.subject) ?? []), ...row.anchors]);
  return [...anchorsOf.keys()].toSorted().flatMap((subject) =>
    claims.flatMap((claim): Attributed[] => {
      const anchors = anchorsOf.get(subject) ?? [];
      const covered = [claim.store, ...claim.readers].filter((ref) =>
        anchors.some((anchor) => covers(anchor, ref)),
      );
      return covered.length === 0 ? [] : [{ subject, claim, covered: uniqueRefs(covered) }];
    }),
  );
};

/**
 * The effects a change has, as its code shows them: every claim head's caches
 * make on a subject that base's did not, so a file touched without changing
 * what it caches derives nothing. A subject is attributed from its anchors
 * only. Each effect is a ruling with the anchors it rests on at head's commit;
 * the output is in one order whatever order the facts came in.
 */
export const deriveEffects = (input: {
  readonly base: SourceFacts;
  readonly head: SourceFacts;
  readonly subjects: readonly SubjectAnchors[];
  readonly intent: Intent;
  readonly vocabulary?: Vocabulary;
}): Derivation => {
  const vocabulary = input.vocabulary ?? DEFAULT_VOCABULARY;
  const before = attribute(storeClaims(input.base, vocabulary), input.subjects);
  const after = attribute(storeClaims(input.head, vocabulary), input.subjects);
  const written = (a: Attributed) =>
    "freshness" in a.claim
      ? writeProposition(a.subject, {
          predicate: "freshness",
          relation: "is",
          value: a.claim.freshness,
        })
      : undefined;
  const claimKey = (a: Attributed): string => {
    const p = written(a);
    return p === undefined
      ? `${a.subject}\n${refKey(a.claim.store)}\n${"undecided" in a.claim ? a.claim.undecided : ""}`
      : `${a.subject}\n${p.predicate}\n${p.relation}\n${String(p.value)}`;
  };
  const held = new Set(before.map(claimKey));
  const fresh = after.filter((a) => !held.has(claimKey(a)));

  const grouped = new Map<string, Attributed[]>();
  for (const a of fresh)
    if ("freshness" in a.claim) grouped.set(claimKey(a), [...(grouped.get(claimKey(a)) ?? []), a]);
  const effects = [...grouped.keys()].toSorted().flatMap((key): ExtractedEffect[] => {
    const group = grouped.get(key) ?? [];
    const [first] = group;
    const proposition = first === undefined ? undefined : written(first);
    if (first === undefined || proposition === undefined) return [];
    const anchors: Anchor[] = uniqueRefs(
      group.flatMap((a) => [a.claim.store, ...a.covered, ...a.claim.subscribedIn]),
    ).map((ref) => ({ path: ref.path, symbol: ref.symbol, commit: input.head.commit }));
    const anchored = { ...proposition, anchors };
    return [
      {
        proposition: anchored,
        anchors,
        declared: isDeclared(input.intent, anchored),
        method: "extractor",
        evidenceClass: "ruling",
      },
    ];
  });
  const undecided = fresh
    .flatMap((a): Undecided[] =>
      "undecided" in a.claim
        ? [{ subject: a.subject, store: a.claim.store, reason: a.claim.undecided }]
        : [],
    )
    .toSorted((a, b) =>
      a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : byRef(a.store, b.store),
    );
  return { effects, undecided };
};
