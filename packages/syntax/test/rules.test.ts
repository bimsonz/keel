/**
 * The rules a tree is read by, each on the smallest source that shows it.
 * forge-lite's trees (`forge-lite.test.ts`) hold them together; these say
 * what each one is, and what is left out.
 */
import { describe, expect, it } from "vitest";
import { factsOf } from "./support/facts.ts";

const CACHE = `
export class Cache {
  readonly #entries = new Map<string, number>();
  get(key: string): number | undefined {
    return this.#entries.get(key);
  }
  set(key: string, value: number): void {
    this.#entries.set(key, value);
  }
}
export function cacheFor(owner: object): Cache {
  return new Cache();
}
export async function cacheLater(): Promise<Cache> {
  return new Cache();
}
`;

const util = (name: string) => `
const ${name} = new Map<string, number>();
export function remember(key: string, value: number) {
  if (!${name}.has(key)) ${name}.set(key, value);
}
`;

describe("name resolution", () => {
  it("[syntax.unresolved-left-out] a call is reported when its receiver's class is declared, made or returned, and left out when it is only named alike", async () => {
    const facts = await factsOf({
      "src/cache.ts": CACHE,
      "src/use.ts": `
import { thing } from "some-package";
import { Cache, cacheFor, cacheLater } from "./cache.ts";

interface Lookalike { get(key: string): number | undefined }
class Sub extends Cache {}

export function declared(cache: Cache) { return cache.get("k"); }
export function made() { const cache = new Cache(); return cache.get("k"); }
export function returned(owner: object) { return cacheFor(owner).get("k"); }
export async function awaited() { const cache = await cacheLater(); return cache.get("k"); }
export function inherited(cache: Sub) { return cache.get("k"); }
export class Holder {
  readonly cache = new Cache();
  constructor(private readonly given: Cache) {}
  own() { return this.cache.get("k"); }
  injected() { return this.given.get("k"); }
}

export function untyped(cache) { return cache.get("k"); }
export function foreign() { return thing.get("k"); }
export function structural(cache: Lookalike) { return cache.get("k"); }
export function unawaited() { const cache = cacheLater(); return cache.get("k"); }
export function disagreeing(flag: boolean, other: Lookalike) {
  let cache = new Cache();
  if (flag) cache = other;
  return cache.get("k");
}
export function computed(cache: Cache, method: "get") { return cache[method]("k"); }
`,
    });
    expect(facts.calls).toEqual([
      "src/use.ts#Holder.injected -> src/cache.ts#Cache.get",
      "src/use.ts#Holder.own -> src/cache.ts#Cache.get",
      // After its own await, so not at once.
      "src/use.ts#awaited -> src/cache.ts#Cache.get deferred",
      "src/use.ts#declared -> src/cache.ts#Cache.get",
      "src/use.ts#inherited -> src/cache.ts#Cache.get",
      "src/use.ts#made -> src/cache.ts#Cache.get",
      "src/use.ts#returned -> src/cache.ts#Cache.get",
    ]);
    expect(facts.skipped).toEqual([]);
  });

  it("[syntax.imports] an import names the file its path names, through a re-export and a `.js` written for a `.ts`, and never a file that only shares its name", async () => {
    const facts = await factsOf(
      {
        "src/a/util.ts": util("a"),
        "src/b/util.ts": util("b"),
        "src/b/index.ts": `export { remember as keep } from "./util.js";\n`,
        "src/b/direct.ts": `import { remember } from "./util.ts";\nexport function direct() { remember("k", 1); }\n`,
        "src/main.ts": `import { keep } from "./b";\nexport function main() { keep("k", 1); }\n`,
      },
      ["src/main.ts", "src/b/direct.ts"],
    );
    expect(facts.calls).toEqual([
      "src/b/direct.ts#direct -> src/b/util.ts#remember",
      "src/main.ts#main -> src/b/util.ts#remember",
    ]);
    // Only what the seeds import is read: the other `util.ts` is no part of it.
    expect(facts.stores).toEqual(["src/b/util.ts#b module"]);
  });
});

describe("stores and their accesses", () => {
  it("[syntax.stores] a store is a binding given a built-in container, held where it is bound, and never a name that only looks like one", async () => {
    const facts = await factsOf({
      "src/stores.ts": `
import { Map as Other } from "some-package";
import type { Context } from "hono";

const table = new Map<string, number>();
const seen = new Set<string>();
const attached = new WeakMap<object, number>();
const foreign = new Other();
let unset: Map<string, number>;

export class Holder {
  static shared = new Map<string, number>();
  readonly #own = new Map<string, number>();
  late: Map<string, number>;
  constructor() { this.late = new Map(); }
  touch(key: string) { this.#own.get(key); this.late.get(key); Holder.shared.get(key); }
}

export function local(key: string) {
  const scratch = new Map<string, number>();
  scratch.set(key, 1);
  return scratch.get(key);
}
export function onRequest(c: Context, key: string) {
  let memo = c.get("memo");
  if (memo === undefined) { memo = new Map(); c.set("memo", memo); }
  return memo.get(key);
}
export function reassigned(other: Map<string, number>, key: string) {
  let mixed = new Map<string, number>();
  mixed = other;
  return mixed.get(key) ?? table.get(key) ?? seen.has(key) ?? attached.get(other) ?? foreign.get(key) ?? unset.get(key);
}
`,
    });
    expect(facts.stores).toEqual([
      "src/stores.ts#Holder.#own instance",
      "src/stores.ts#Holder.late instance",
      "src/stores.ts#Holder.shared module",
      "src/stores.ts#attached module weak",
      "src/stores.ts#local.scratch local",
      "src/stores.ts#onRequest.memo request",
      "src/stores.ts#seen module",
      "src/stores.ts#table module",
    ]);
    expect(facts.accesses).toEqual([
      "read src/stores.ts#Holder.#own in src/stores.ts#Holder.touch by [key] expiring null",
      "read src/stores.ts#Holder.late in src/stores.ts#Holder.touch by [key] expiring null",
      "read src/stores.ts#Holder.shared in src/stores.ts#Holder.touch by [key] expiring null",
      "read src/stores.ts#attached in src/stores.ts#reassigned by [other] expiring null",
      "read src/stores.ts#local.scratch in src/stores.ts#local by [key] expiring null",
      "read src/stores.ts#onRequest.memo in src/stores.ts#onRequest by [key] expiring null",
      "read src/stores.ts#seen in src/stores.ts#reassigned by [key] expiring null",
      "read src/stores.ts#table in src/stores.ts#reassigned by [key] expiring null",
      "write src/stores.ts#local.scratch in src/stores.ts#local by [key] expiring null",
    ]);
  });

  it("[syntax.keys-and-expiry] a key's parts are the names it is built from, and an expiry is a deadline of a constant with a unit, or unknown", async () => {
    const facts = await factsOf({
      "src/ttl.ts": `
import { LIFETIME_SECONDS } from "./config.ts";
const TTL_MS = 5 * 60 * 1_000;
const entries = new Map<string, unknown>();
const keyOf = (a: string, b: string) => a + ":" + b;

export function byHelper(sessionId: string, repo: { id: string }, now: number) {
  entries.set(keyOf(sessionId, repo.id), { value: 1, expiresAt: now + TTL_MS });
}
export function byTemplate(c: { var: { session?: { id: string } } }, now: number) {
  const key = \`\${c.var.session?.id ?? "-"}:\${JSON.stringify([now])}\`;
  const entry = { value: 1, expiry: now + LIFETIME_SECONDS };
  entries.set(key, entry);
}
export function bare(userId: string, now: number) {
  entries.set(userId.trim(), { value: 1, deadline: now + 60_000 });
}
export function computedLater(userId: string, deadline: number) {
  entries.set(userId, { value: 1, validUntil: deadline });
}
export function forever(userId: string) {
  entries.set(userId, { value: 1 });
  for (const [key] of entries) entries.delete(key);
  entries.clear();
}
`,
      "src/config.ts": `export const LIFETIME_SECONDS = 90;\n`,
    });
    expect(facts.accesses).toEqual([
      "evict src/ttl.ts#entries in src/ttl.ts#forever by [] expiring null",
      "evict src/ttl.ts#entries in src/ttl.ts#forever by [key] expiring null",
      "read src/ttl.ts#entries in src/ttl.ts#forever by [] expiring null",
      'write src/ttl.ts#entries in src/ttl.ts#bare by [userId] expiring "unknown"',
      'write src/ttl.ts#entries in src/ttl.ts#byHelper by [sessionId, repo.id] expiring {"seconds":300}',
      'write src/ttl.ts#entries in src/ttl.ts#byTemplate by [c.var.session.id, now] expiring {"seconds":90}',
      'write src/ttl.ts#entries in src/ttl.ts#computedLater by [userId] expiring "unknown"',
      "write src/ttl.ts#entries in src/ttl.ts#forever by [userId] expiring null",
    ]);
  });
});

describe("when a thing runs", () => {
  it("[syntax.deferred] an access or a call is deferred after an await in its function, inside a loop that awaits, or in a callback given to a timer, and at once otherwise", async () => {
    const facts = await factsOf({
      "src/later.ts": `
const entries = new Map<string, number>();
declare function load(key: string): Promise<number>;
declare const ctx: { waitUntil(p: unknown): void };

function evict(key: string) { entries.delete(key); }

export async function before(key: string) { entries.delete(key); await load(key); }
export async function operand(key: string) { await entries.get(key); }
export async function after(key: string) { await load(key); entries.delete(key); }
export async function argument(key: string) { entries.set(key, await load(key)); }
export async function loop(keys: string[]) { for (const key of keys) { entries.delete(key); await load(key); } }
export function timer(key: string) { setTimeout(() => entries.delete(key), 0); }
export function named(key: string) { const later = () => { entries.delete(key); }; setTimeout(later, 0); }
export function background(key: string) { ctx.waitUntil(load(key).then(() => entries.delete(key))); }
export function inline(keys: string[]) { keys.forEach((key) => entries.delete(key)); }
export async function callsAfter(key: string) { await load(key); evict(key); }
export function callsAtOnce(key: string) { evict(key); }
export async function both(key: string) { evict(key); await load(key); evict(key); }
export function passed(key: string) { setTimeout(evict, 0); }
`,
    });
    expect(facts.accesses).toEqual([
      "evict src/later.ts#entries in src/later.ts#after by [key] expiring null deferred",
      "evict src/later.ts#entries in src/later.ts#background by [key] expiring null deferred",
      "evict src/later.ts#entries in src/later.ts#before by [key] expiring null",
      "evict src/later.ts#entries in src/later.ts#evict by [key] expiring null",
      "evict src/later.ts#entries in src/later.ts#inline by [key] expiring null",
      "evict src/later.ts#entries in src/later.ts#loop by [key] expiring null deferred",
      "evict src/later.ts#entries in src/later.ts#named by [key] expiring null deferred",
      "evict src/later.ts#entries in src/later.ts#timer by [key] expiring null deferred",
      "read src/later.ts#entries in src/later.ts#operand by [key] expiring null",
      "write src/later.ts#entries in src/later.ts#argument by [key] expiring null deferred",
    ]);
    expect(facts.calls).toEqual([
      "src/later.ts#both -> src/later.ts#evict",
      "src/later.ts#callsAfter -> src/later.ts#evict deferred",
      "src/later.ts#callsAtOnce -> src/later.ts#evict",
      "src/later.ts#passed -> src/later.ts#evict deferred",
    ]);
  });

  it("[syntax.subscriptions] a registrar called with an event's name and a function is a subscription, its handler a symbol of its own, and a route registration is not one", async () => {
    const facts = await factsOf({
      "src/bus.ts": `
const entries = new Map<string, number>();
declare const bus: { subscribe(e: string, f: (e: { key: string }) => void): void; on(e: string, f: unknown): void };
declare const app: { get(path: string, f: unknown): void; on(method: string, path: string, f: unknown): void };

function drop(event: { key: string }) { entries.delete(event.key); }

export function wire() {
  bus.subscribe("entry.removed", (event) => entries.delete(event.key));
  bus.on("entry.changed", async (event: { key: string }) => { entries.delete(event.key); });
  bus.on("entry.renamed", drop);
  bus.on("entry.unknown", missing);
  app.get("/entries", () => entries.get("k"));
  app.on("GET", "/entries", () => entries.get("k"));
}
`,
    });
    expect(facts.subscriptions).toEqual([
      "entry.changed via on in src/bus.ts#wire to src/bus.ts#wire~entry.changed async",
      "entry.removed via subscribe in src/bus.ts#wire to src/bus.ts#wire~entry.removed",
      "entry.renamed via on in src/bus.ts#wire to src/bus.ts#drop",
    ]);
    expect(facts.accesses).toEqual([
      "evict src/bus.ts#entries in src/bus.ts#drop by [event.key] expiring null",
      "evict src/bus.ts#entries in src/bus.ts#wire~entry.changed by [event.key] expiring null",
      "evict src/bus.ts#entries in src/bus.ts#wire~entry.removed by [event.key] expiring null",
      "read src/bus.ts#entries in src/bus.ts#wire by [] expiring null",
    ]);
  });
});

describe("impurities", () => {
  it("[syntax.impure-builtins] a call to a built-in that writes output, reaches the network, reads the clock or randomness, or schedules work is reported with what it does; a pure built-in, a dated `new Date`, or a built-in only named is not", async () => {
    const facts = await factsOf({
      "src/effects.ts": `
export function logs(n: number) { console.info("priced", n); return n; }
export function warns() { globalThis.console.warn("x"); }
export async function fetches(url: string) { return await fetch(url); }
export function fetchesGlobal(url: string) { return globalThis.fetch(url); }
export function connects(url: string) { return new WebSocket(url); }
export function now() { return Date.now(); }
export function today() { return new Date(); }
export function stamp() { return Date(); }
export function elapsed() { return performance.now(); }
export function roll() { return Math.random(); }
export function id() { return crypto.randomUUID(); }
export function bytes(into: Uint8Array) { return crypto.getRandomValues(into); }
export function later(n: number) { setTimeout(() => console.log(n), 10); }
export function every() { return setInterval(tick, 1000); }
export function soon() { queueMicrotask(tick); }
export function next() { setImmediate(tick); }
export const started = Date.now();
function tick() {}

export function at(ms: number) { return new Date(ms); }
export function biggest(a: number, b: number) { return Math.max(a, b); }
export function parsed(text: string) { return JSON.parse(text); }
export function handed(take: (c: Console) => void) { take(console); }
export function digest(data: ArrayBuffer) { return crypto.subtle.digest("SHA-256", data); }
export function sorted(xs: number[]) { return [...xs].toSorted(); }
`,
    });
    expect(facts.impurities).toEqual(
      [
        "output console.info in src/effects.ts#logs",
        "output console.warn in src/effects.ts#warns",
        "network fetch in src/effects.ts#fetches",
        "network fetch in src/effects.ts#fetchesGlobal",
        "network new WebSocket in src/effects.ts#connects",
        "clock Date.now in src/effects.ts#now",
        "clock new Date in src/effects.ts#today",
        "clock Date in src/effects.ts#stamp",
        "clock performance.now in src/effects.ts#elapsed",
        "random Math.random in src/effects.ts#roll",
        "random crypto.randomUUID in src/effects.ts#id",
        "random crypto.getRandomValues in src/effects.ts#bytes",
        // The callback runs later, and still runs: when is not whether.
        "schedule setTimeout in src/effects.ts#later",
        "output console.log in src/effects.ts#later",
        "schedule setInterval in src/effects.ts#every",
        "schedule queueMicrotask in src/effects.ts#soon",
        "schedule setImmediate in src/effects.ts#next",
        "clock Date.now in src/effects.ts#started",
      ].toSorted(),
    );
  });

  it("[syntax.impure-shadowed] a name the file imports, declares at its top level, or binds as a parameter or a local is not the built-in, and calling it is reported as nothing", async () => {
    const facts = await factsOf({
      "src/my-console.ts": "export const console = { info(_: string) {} };\n",
      "src/shadow.ts": `
import { console } from "./my-console.ts";
import fetch from "some-fetch";
const Date = { now: () => 0 };
function setTimeout(fn: () => void) { fn(); }
class WebSocket { constructor(readonly url: string) {} }
export function logs() { console.info("x"); }
export function fetches() { return fetch("u"); }
export function now() { return Date.now(); }
export function later() { setTimeout(() => {}); }
export function connects() { return new WebSocket("u"); }
export function given(Math: { random(): number }) { return Math.random(); }
export function local() { const performance = { now: () => 1 }; return performance.now(); }
`,
    });
    expect(facts.impurities).toEqual([]);
  });

  it("[syntax.module-writes] an assignment, an update or a member assignment to a binding the module declares, or through one it imports, is a write to module state; a local or parameter of that name, and `this`, are not", async () => {
    const facts = await factsOf({
      "src/settings.ts": 'export const settings = { mode: "slow" };\n',
      "src/state.ts": `
import { settings } from "./settings.ts";
let hits = 0;
let last: string | undefined;
const seen = { count: 0 };
export function assigns(key: string) { last = key; }
export function adds() { hits += 1; }
export function increments() { hits++; }
export function decrements() { --hits; }
export function sets() { seen.count = 1; }
export function bumps() { seen.count += 1; }
export function configures() { settings.mode = "fast"; }
export function inLater() { setTimeout(() => { hits = 0; }); }

export function shadowedLocal() { let hits = 0; hits++; return hits; }
export function shadowedParam(last: string) { last = last.trim(); return last; }
export function own(this: { n: number }) { this.n = 1; }
export class Counter { n = 0; bump() { this.n++; } }
export function readsOnly() { return hits + seen.count; }
`,
    });
    expect(facts.impurities).toEqual(
      [
        "module-state last in src/state.ts#assigns",
        "module-state hits in src/state.ts#adds",
        "module-state hits in src/state.ts#increments",
        "module-state hits in src/state.ts#decrements",
        "module-state seen.count in src/state.ts#sets",
        "module-state seen.count in src/state.ts#bumps",
        "module-state settings.mode in src/state.ts#configures",
        "module-state hits in src/state.ts#inLater",
        "schedule setTimeout in src/state.ts#inLater",
      ].toSorted(),
    );
  });

  it("[syntax.calls-to-impure] a resolved call that leads to an impurity is reported, as one that leads to a store access is, and a call to a pure function still is not", async () => {
    const facts = await factsOf({
      "src/log.ts": `
export function log(message: string) { console.info(message); }
export function quiet(message: string) { return message.length; }
`,
      "src/price.ts": `
import { log, quiet } from "./log.ts";
export function price(n: number) { log("priced"); quiet("x"); return n * 2; }
export function total(n: number) { return price(n) + 1; }
`,
    });
    expect(facts.calls).toEqual([
      "src/price.ts#price -> src/log.ts#log",
      "src/price.ts#total -> src/price.ts#price",
    ]);
    expect(facts.impurities).toEqual(["output console.info in src/log.ts#log"]);
  });
});
