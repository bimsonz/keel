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
