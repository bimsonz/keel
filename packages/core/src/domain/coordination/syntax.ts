/**
 * What a parser reports about a source tree, for effect derivation: structure
 * only. The adapter that fills it resolves names (imports, class members,
 * local bindings, declared return types) and judges nothing: it never says
 * which store is a cache, how fresh anything is, or which subject a symbol
 * belongs to. `deriveEffects` does that, over these facts.
 */
import { Schema } from "effect";
import { CommitSha } from "../kernel/index.ts";

/**
 * A named piece of code. `symbol` is the name as an anchor writes it: a
 * top-level name (`callerRole`), a class member (`RoleCache.get`,
 * `RoleCache.#roles`), a local a function declares (`callerRole.memo`), or,
 * for a handler written inline where it is registered, the registering
 * symbol and its event (`roleCacheFor~collaborator.removed`).
 */
export const SymbolRef = Schema.Struct({
  path: Schema.NonEmptyString,
  symbol: Schema.NonEmptyString,
});
export type SymbolRef = typeof SymbolRef.Type;

/**
 * Where a keyed container lives, which bounds how long an entry can: at
 * module scope, in a class field, on the framework's per-request context, or
 * in a function body. `unknown` when the parser cannot tell.
 */
export const StoreHolder = Schema.Literals(["module", "instance", "request", "local", "unknown"]);
export type StoreHolder = typeof StoreHolder.Type;

/** A keyed container the tree declares: a map, a set, a dictionary object, a key-value client. */
export const KeyedStore = Schema.Struct({
  at: SymbolRef,
  holder: StoreHolder,
  /** Keys are held weakly (a WeakMap or WeakSet): an entry lives exactly as long as its key. */
  weak: Schema.Boolean,
});
export type KeyedStore = typeof KeyedStore.Type;

/** A write's expiry: a literal number of seconds, or one the parser saw and could not evaluate. */
export const Expiry = Schema.Union([
  Schema.Struct({ seconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Literal("unknown"),
]);
export type Expiry = typeof Expiry.Type;

/** One read, write or removal on a store, in the symbol that performs it. */
export const StoreAccess = Schema.Struct({
  store: SymbolRef,
  in: SymbolRef,
  op: Schema.Literals(["read", "write", "evict"]),
  /**
   * The identifier paths the key is built from (`sessionId`, `c.var.session.id`),
   * read through local bindings and through the arguments of a helper that
   * builds the key.
   */
  key: Schema.Array(Schema.String),
  /** On a write only: when the entry expires, if the write says. */
  expiry: Schema.optional(Expiry),
  /** After an `await` in its function, or inside a callback handed to a timer, a queue or `waitUntil`. */
  deferred: Schema.Boolean,
});
export type StoreAccess = typeof StoreAccess.Type;

/**
 * A call from one symbol to another the parser resolved. A call it cannot
 * resolve is left out, never guessed. Only calls that lead to a store access
 * or an impurity matter, so an adapter may leave out the rest.
 */
export const Call = Schema.Struct({
  from: SymbolRef,
  to: SymbolRef,
  deferred: Schema.Boolean,
});
export type Call = typeof Call.Type;

/** A handler registered for a named event. */
export const Subscription = Schema.Struct({
  /** The event's name, as the literal the code registers. */
  event: Schema.String,
  /** The registering method's name: `subscribe`, `on`. */
  via: Schema.NonEmptyString,
  /** The symbol that registers it. */
  in: SymbolRef,
  handler: SymbolRef,
  /** The handler is an async function. */
  async: Schema.Boolean,
});
export type Subscription = typeof Subscription.Type;

/**
 * What an impure step does: write the program's output, reach the network,
 * read the clock or randomness, leave work to run after the call returns, or
 * write state a module holds.
 */
export const ImpurityKind = Schema.Literals([
  "output",
  "network",
  "clock",
  "random",
  "schedule",
  "module-state",
]);
export type ImpurityKind = typeof ImpurityKind.Type;

/**
 * A step in a symbol that a pure function never takes: a call to a built-in
 * the file does not shadow that does one of those things, or a write to a
 * binding a module declares at its top level. Only a built-in whose effect is
 * certain from its name is reported; a call through a parameter, a field or
 * an alias is not, since syntax cannot tell what it reaches.
 */
export const Impurity = Schema.Struct({
  in: SymbolRef,
  /**
   * As written from the global down (`console.info`, `Date.now`, `fetch`, and
   * `new Date` for a construction), or the binding written (`hits`, `seen.count`).
   */
  what: Schema.NonEmptyString,
  kind: ImpurityKind,
});
export type Impurity = typeof Impurity.Type;

/** The facts of one tree, at one commit, over the files a derivation asked for. */
export const SourceFacts = Schema.Struct({
  commit: CommitSha,
  stores: Schema.Array(KeyedStore),
  accesses: Schema.Array(StoreAccess),
  calls: Schema.Array(Call),
  subscriptions: Schema.Array(Subscription),
  impurities: Schema.Array(Impurity),
});
export type SourceFacts = typeof SourceFacts.Type;
