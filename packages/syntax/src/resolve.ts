/**
 * Resolves the files' models against each other into source facts: which
 * bindings are keyed stores, which calls reach which symbol, and which store
 * each read, write and removal touches. Nothing is guessed. A receiver's
 * class is known only from `new C()`, `this`, a declared type, or the declared
 * return type of a callee that itself resolved, followed through bindings
 * that all agree; a call whose receiver is anything else is left out.
 */
import type {
  Call,
  Expiry,
  Impurity,
  ImpurityKind,
  KeyedStore,
  SourceFacts,
  StoreAccess,
  StoreHolder,
  Subscription,
  SymbolRef,
} from "@keeltown/core/domain/coordination";
import {
  type ClassModel,
  type Expr,
  type ExpirySeen,
  type FileModel,
  type Source,
  type SymbolModel,
  type TypeRef,
  unitOf,
} from "./model.ts";

/** The facts of a tree, before the commit they were read at is put on them. */
export type TreeFacts = Omit<SourceFacts, "commit">;

/** The built-in keyed containers, and whether each holds its keys weakly. */
const CONTAINERS: Readonly<Record<string, boolean>> = {
  Map: false,
  Set: false,
  WeakMap: true,
  WeakSet: true,
};
const OPS: Readonly<Record<string, StoreAccess["op"]>> = {
  get: "read",
  has: "read",
  keys: "read",
  values: "read",
  entries: "read",
  forEach: "read",
  set: "write",
  add: "write",
  delete: "evict",
  clear: "evict",
};
/**
 * The built-ins a pure function never calls, by their path from the global,
 * and what each does: `fetch` sends a request out of the isolate; the clock
 * and the random sources answer differently on every call; the schedulers
 * leave work that runs after the call returns. `Date.parse`, `Math.max`,
 * `JSON.parse` and the like are pure and are not here.
 */
const IMPURE_CALLS: ReadonlyMap<string, ImpurityKind> = new Map([
  ["fetch", "network"],
  ["Date", "clock"],
  ["Date.now", "clock"],
  ["performance.now", "clock"],
  ["Math.random", "random"],
  ["crypto.randomUUID", "random"],
  ["crypto.getRandomValues", "random"],
  ["setTimeout", "schedule"],
  ["setInterval", "schedule"],
  ["setImmediate", "schedule"],
  ["queueMicrotask", "schedule"],
]);
/** Built-ins every method of which is impure: each of `console`'s writes the program's output, or keeps its counters and timers. */
const IMPURE_ROOTS: ReadonlyMap<string, ImpurityKind> = new Map([["console", "output"]]);
/**
 * Constructions that are impure: a socket connects, and a date given no time
 * reads the clock (`new Date(ms)` is pure).
 */
const IMPURE_NEW: ReadonlyMap<string, { readonly kind: ImpurityKind; readonly bare: boolean }> =
  new Map([
    ["WebSocket", { kind: "network", bare: false }],
    ["Date", { kind: "clock", bare: true }],
  ]);
const GLOBAL = "globalThis.";
const MAX_DEPTH = 24;

type Val =
  | { readonly k: "store"; readonly at: SymbolRef; readonly weak: boolean }
  | { readonly k: "instance"; readonly path: string; readonly cls: string }
  | { readonly k: "class"; readonly path: string; readonly cls: string }
  | { readonly k: "fn"; readonly at: SymbolRef }
  /** Something a package exports, or an instance of a type it exports. */
  | {
      readonly k: "foreign";
      readonly pkg: string;
      readonly name: string;
      readonly instance: boolean;
    }
  | { readonly k: "promise"; readonly path: string; readonly of: TypeRef | undefined }
  | { readonly k: "number"; readonly value: number };

type Scope = {
  readonly path: string;
  readonly file: FileModel;
  readonly sym?: SymbolModel;
  /** The class a field's initialiser is written in. */
  readonly cls?: string;
};

const refKey = (ref: SymbolRef): string => `${ref.path}\n${ref.symbol}`;
const ordered = <T>(items: Iterable<T>, key: (item: T) => string): T[] =>
  [...new Map([...items].map((item) => [key(item), item])).entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);

/** The name is the file's own or the symbol's, so it is not the built-in of that name. */
const shadowed = (name: string, scope: Scope): boolean =>
  scope.sym?.bindings.has(name) === true ||
  scope.file.imports.has(name) ||
  scope.file.variables.has(name) ||
  scope.file.declared.has(name);

/** An expression's path of names (`console.info`), when it is one. */
const namesOf = (expr: Expr): string | undefined => {
  if (expr.k === "name") return expr.name;
  if (expr.k !== "member") return undefined;
  const head = namesOf(expr.object);
  return head === undefined ? undefined : `${head}.${expr.property}`;
};

/**
 * What a call or a construction does when it is one of an impure built-in,
 * named from the global (`globalThis.fetch` is `fetch`) and not shadowed.
 */
const impurityOf = (
  callee: Expr,
  args: readonly Expr[],
  scope: Scope,
): Omit<Impurity, "in"> | undefined => {
  const constructs = callee.k === "new";
  const named = namesOf(constructs ? callee.ctor : callee);
  if (named === undefined) return undefined;
  const [first = named] = named.split(".");
  // A name the file or the symbol declares, imports or binds is not the global's.
  if (shadowed(first, scope)) return undefined;
  const path = named.startsWith(GLOBAL) ? named.slice(GLOBAL.length) : named;
  if (constructs) {
    const made = IMPURE_NEW.get(path);
    return made === undefined || (made.bare && args.length > 0)
      ? undefined
      : { what: `new ${path}`, kind: made.kind };
  }
  const [root = path] = path.split(".");
  const kind = IMPURE_CALLS.get(path) ?? (path === root ? undefined : IMPURE_ROOTS.get(root));
  return kind === undefined ? undefined : { what: path, kind };
};

/**
 * A write to state the module holds: to a binding it declares at its top
 * level, or a member of one, or a member of a binding it imports; never to
 * a local or a parameter of that name.
 */
const writesModule = (path: string, scope: Scope): boolean => {
  const [root = path] = path.split(".");
  if (scope.sym?.bindings.has(root) === true) return false;
  return scope.file.variables.has(root) || (root !== path && scope.file.imports.has(root));
};

/** The container a `new Map()` makes, when `Map` is the built-in. */
const containerOf = (expr: Expr, scope: Scope): string | undefined =>
  expr.k === "new" &&
  expr.ctor.k === "name" &&
  expr.ctor.name in CONTAINERS &&
  !shadowed(expr.ctor.name, scope)
    ? expr.ctor.name
    : undefined;

/** A Hono `Context`: what `c.set` puts on it lives as long as the request. */
const isHonoContext = (value: Val | undefined): boolean =>
  value?.k === "foreign" && value.instance && value.pkg === "hono" && value.name === "Context";

export function factsOf(
  files: ReadonlyMap<string, FileModel>,
  /** The file a relative specifier names from `from`, when it was read. */
  resolveModule: (from: string, specifier: string) => string | undefined,
): TreeFacts {
  const symbols = new Map<string, Map<string, SymbolModel>>();
  for (const [path, file] of files)
    symbols.set(path, new Map(file.symbols.map((symbol) => [symbol.name, symbol])));
  const symbolAt = (ref: SymbolRef): SymbolModel | undefined =>
    symbols.get(ref.path)?.get(ref.symbol);

  /** The request-context slots a symbol puts the local `name` in: `c.set("slot", name)`. */
  const slotsOf = (scope: Scope, name: string, depth: number): ReadonlySet<string> => {
    const owner =
      scope.sym === undefined ? undefined : symbols.get(scope.path)?.get(scope.sym.owner);
    const slots = new Set<string>();
    for (const event of owner?.events ?? []) {
      if (event.k !== "call" || event.callee.k !== "member" || event.callee.property !== "set")
        continue;
      const [slot, put] = event.args;
      if (slot?.k !== "string" || put?.k !== "name" || put.name !== name) continue;
      if (isHonoContext(evaluate(event.callee.object, scope, depth + 1))) slots.add(slot.value);
    }
    return slots;
  };

  const typeValue = (type: TypeRef | undefined, scope: Scope, depth: number): Val | undefined => {
    if (type === undefined || depth > MAX_DEPTH) return undefined;
    if (
      type.name === "Promise" &&
      !shadowed("Promise", scope) &&
      !scope.file.classes.has("Promise")
    )
      return { k: "promise", path: scope.path, of: type.args[0] };
    const named = lookupTop(scope.path, type.name, depth + 1);
    if (named?.k === "class") return { k: "instance", path: named.path, cls: named.cls };
    if (named?.k === "foreign" && !named.instance) return { ...named, instance: true };
    return undefined;
  };

  /**
   * What a binding holds. A store when every value it is given is the same
   * built-in container (or a read back of the request slot it was put in);
   * otherwise its declared type; otherwise the one thing all its values are.
   */
  const bindingValue = (
    sources: readonly Source[],
    scope: Scope,
    store: string,
    local: string | undefined,
    depth: number,
  ): Val | undefined => {
    if (depth > MAX_DEPTH) return undefined;
    const values = sources.filter((source) => source.k !== "type");
    const made = values.flatMap((source) =>
      source.k === "value" ? (containerOf(source.expr, scope) ?? []) : [],
    );
    const [container] = made;
    if (container !== undefined && made.every((kind) => kind === container)) {
      const slots = local === undefined ? new Set<string>() : slotsOf(scope, local, depth);
      const ownSlot = (expr: Expr): boolean => {
        if (expr.k !== "call" || expr.callee.k !== "member" || expr.callee.property !== "get")
          return false;
        const [slot] = expr.args;
        return (
          slot?.k === "string" &&
          slots.has(slot.value) &&
          isHonoContext(evaluate(expr.callee.object, scope, depth + 1))
        );
      };
      const whole = values.every(
        (source) =>
          source.k === "value" &&
          (containerOf(source.expr, scope) !== undefined || ownSlot(source.expr)),
      );
      if (whole)
        return {
          k: "store",
          at: { path: scope.path, symbol: store },
          weak: CONTAINERS[container] === true,
        };
    }
    for (const source of sources)
      if (source.k === "type") {
        const typed = typeValue(source.type, scope, depth + 1);
        if (typed !== undefined) return typed;
      }
    let agreed: Val | undefined;
    for (const source of values) {
      if (source.k !== "value") return undefined;
      const value = evaluate(source.expr, scope, depth + 1);
      if (value === undefined) return undefined;
      if (agreed !== undefined && JSON.stringify(agreed) !== JSON.stringify(value))
        return undefined;
      agreed = value;
    }
    return agreed;
  };

  /** A top-level name of a file: a function, a class, a module variable, or what an import names. */
  function lookupTop(path: string, name: string, depth: number): Val | undefined {
    const file = files.get(path);
    if (file === undefined || depth > MAX_DEPTH) return undefined;
    const fn = file.functions.get(name);
    if (fn !== undefined) return { k: "fn", at: { path, symbol: fn.name } };
    if (file.classes.has(name)) return { k: "class", path, cls: name };
    const variable = file.variables.get(name);
    if (variable !== undefined)
      return bindingValue(variable, { path, file }, name, undefined, depth + 1);
    const imported = file.imports.get(name);
    if (imported === undefined) return undefined;
    if (!imported.from.startsWith("."))
      return { k: "foreign", pkg: imported.from, name: imported.name, instance: false };
    const target = resolveModule(path, imported.from);
    return target === undefined ? undefined : exportOf(target, imported.name, depth + 1);
  }

  function exportOf(path: string, name: string, depth: number): Val | undefined {
    const file = files.get(path);
    // A namespace import's members are not followed.
    if (file === undefined || depth > MAX_DEPTH || name === "*") return undefined;
    const local = file.exportsAs.get(name) ?? (name === "default" ? undefined : name);
    const own = local === undefined ? undefined : lookupTop(path, local, depth + 1);
    if (own !== undefined) return own;
    for (const reexport of file.reexports) {
      if (reexport.exported !== name) continue;
      const target = resolveModule(path, reexport.from);
      return target === undefined ? undefined : exportOf(target, reexport.name, depth + 1);
    }
    for (const star of file.stars) {
      const target = resolveModule(path, star);
      const found = target === undefined ? undefined : exportOf(target, name, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** A member of a class, looked for up its `extends` chain. */
  function memberValue(path: string, cls: string, name: string, depth: number): Val | undefined {
    const file = files.get(path);
    const model: ClassModel | undefined = file?.classes.get(cls);
    if (file === undefined || model === undefined || depth > MAX_DEPTH) return undefined;
    const scope: Scope = { path, file, cls };
    const field = model.fields.get(name);
    const held =
      field === undefined
        ? undefined
        : bindingValue(field.sources, scope, `${cls}.${name}`, undefined, depth + 1);
    if (held !== undefined) return held;
    const method = model.methods.get(name);
    if (method !== undefined) return { k: "fn", at: { path, symbol: method.name } };
    const base =
      model.extends === undefined ? undefined : evaluate(model.extends, scope, depth + 1);
    return base?.k === "class" ? memberValue(base.path, base.cls, name, depth + 1) : undefined;
  }

  function evaluate(expr: Expr, scope: Scope, depth: number): Val | undefined {
    if (depth > MAX_DEPTH) return undefined;
    switch (expr.k) {
      case "name": {
        const local = scope.sym?.bindings.get(expr.name);
        return local === undefined || scope.sym === undefined
          ? lookupTop(scope.path, expr.name, depth + 1)
          : bindingValue(local, scope, `${scope.sym.owner}.${expr.name}`, expr.name, depth + 1);
      }
      case "this": {
        const cls = scope.sym?.cls ?? scope.cls;
        return cls === undefined ? undefined : { k: "instance", path: scope.path, cls };
      }
      case "member": {
        const object = evaluate(expr.object, scope, depth + 1);
        return object?.k === "instance" || object?.k === "class"
          ? memberValue(object.path, object.cls, expr.property, depth + 1)
          : undefined;
      }
      case "new": {
        // A container no name is bound to is no one's store.
        if (containerOf(expr, scope) !== undefined) return undefined;
        const ctor = evaluate(expr.ctor, scope, depth + 1);
        return ctor?.k === "class" ? { k: "instance", path: ctor.path, cls: ctor.cls } : undefined;
      }
      case "call": {
        const callee = evaluate(expr.callee, scope, depth + 1);
        if (callee?.k !== "fn") return undefined;
        const file = files.get(callee.at.path);
        const returns = symbolAt(callee.at)?.returns;
        return file === undefined
          ? undefined
          : typeValue(returns, { path: callee.at.path, file }, depth + 1);
      }
      case "await": {
        const awaited = evaluate(expr.of, scope, depth + 1);
        const file = awaited?.k === "promise" ? files.get(awaited.path) : undefined;
        if (awaited?.k !== "promise") return awaited;
        return file === undefined
          ? undefined
          : typeValue(awaited.of, { path: awaited.path, file }, depth + 1);
      }
      case "number":
        return { k: "number", value: expr.value };
      default:
        return undefined;
    }
  }

  const stores = new Map<string, KeyedStore>();
  const noteStore = (value: Val | undefined, holder: StoreHolder): void => {
    if (value?.k === "store")
      stores.set(refKey(value.at), { at: value.at, holder, weak: value.weak });
  };
  for (const [path, file] of files) {
    for (const [name, sources] of file.variables)
      noteStore(bindingValue(sources, { path, file }, name, undefined, 0), "module");
    for (const model of file.classes.values())
      for (const [name, field] of model.fields)
        noteStore(
          bindingValue(
            field.sources,
            { path, file, cls: model.name },
            `${model.name}.${name}`,
            undefined,
            0,
          ),
          field.static ? "module" : "instance",
        );
    for (const sym of file.symbols) {
      if (sym.owner !== sym.name) continue;
      const scope: Scope = { path, file, sym };
      for (const [name, sources] of sym.bindings)
        noteStore(
          bindingValue(sources, scope, `${sym.name}.${name}`, name, 0),
          // A local put on the request's context lives as long as the request.
          slotsOf(scope, name, 0).size > 0 ? "request" : "local",
        );
    }
  }

  const expiryOf = (seen: ExpirySeen | undefined, scope: Scope): Expiry | undefined => {
    if (seen === undefined || seen === "unknown") return seen;
    const duration = evaluate({ k: "name", name: seen.constant }, scope, 0);
    const unit = unitOf(seen.constant);
    const seconds = duration?.k === "number" && unit !== undefined ? duration.value * unit : -1;
    return Number.isFinite(seconds) && seconds >= 0 ? { seconds } : "unknown";
  };

  const accesses: StoreAccess[] = [];
  const impurities: Impurity[] = [];
  const edges = new Map<string, Call>();
  const edge = (from: SymbolRef, to: Val | undefined, deferred: boolean): void => {
    if (to?.k !== "fn") return;
    const key = `${refKey(from)}\n${refKey(to.at)}`;
    // One edge a pair: it is at once when any of its calls is.
    edges.set(key, { from, to: to.at, deferred: deferred && (edges.get(key)?.deferred ?? true) });
  };
  for (const [path, file] of files)
    for (const sym of file.symbols) {
      const scope: Scope = { path, file, sym };
      const here: SymbolRef = { path, symbol: sym.name };
      for (const event of sym.events) {
        if (event.k === "ref") {
          edge(here, evaluate(event.target, scope, 0), event.deferred);
          continue;
        }
        if (event.k === "write") {
          if (writesModule(event.path, scope))
            impurities.push({ in: here, what: event.path, kind: "module-state" });
          continue;
        }
        if (event.k === "iterate") {
          const iterated = evaluate(event.of, scope, 0);
          if (iterated?.k === "store")
            accesses.push({
              store: iterated.at,
              in: here,
              op: "read",
              key: [],
              deferred: event.deferred,
            });
          continue;
        }
        const { callee } = event;
        const impurity = impurityOf(callee, event.args, scope);
        if (impurity !== undefined) impurities.push({ in: here, ...impurity });
        if (callee.k === "new") {
          const made = evaluate(callee.ctor, scope, 0);
          if (made?.k === "class")
            edge(here, memberValue(made.path, made.cls, "constructor", 0), event.deferred);
          continue;
        }
        if (callee.k !== "member") {
          edge(here, evaluate(callee, scope, 0), event.deferred);
          continue;
        }
        const object = evaluate(callee.object, scope, 0);
        const op = OPS[callee.property];
        if (object?.k === "store" && op !== undefined) {
          const expiry = op === "write" ? expiryOf(event.expiry, scope) : undefined;
          accesses.push({
            store: object.at,
            in: here,
            op,
            key: [...new Set(event.key)],
            ...(expiry === undefined ? {} : { expiry }),
            deferred: event.deferred,
          });
        } else if (object?.k === "instance" || object?.k === "class")
          edge(here, memberValue(object.path, object.cls, callee.property, 0), event.deferred);
      }
    }

  // Only calls that lead to a store access or an impurity are reported.
  const calledBy = new Map<string, string[]>();
  for (const call of edges.values())
    calledBy.set(refKey(call.to), [...(calledBy.get(refKey(call.to)) ?? []), refKey(call.from)]);
  const reaches = new Set([...accesses, ...impurities].map((step) => refKey(step.in)));
  const queue = [...reaches];
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const caller of calledBy.get(next) ?? [])
      if (!reaches.has(caller)) {
        reaches.add(caller);
        queue.push(caller);
      }

  const subscriptions: Subscription[] = [];
  for (const [path, file] of files)
    for (const subscription of file.subscriptions) {
      const base = {
        event: subscription.event,
        via: subscription.via,
        in: { path, symbol: subscription.in.name },
      };
      if ("symbol" in subscription.handler) {
        subscriptions.push({
          ...base,
          handler: { path, symbol: subscription.handler.symbol },
          async: subscription.handler.async,
        });
        continue;
      }
      const handler = evaluate(subscription.handler.expr, { path, file, sym: subscription.in }, 0);
      const model = handler?.k === "fn" ? symbolAt(handler.at) : undefined;
      if (handler?.k === "fn" && model !== undefined)
        subscriptions.push({ ...base, handler: handler.at, async: model.async });
    }

  return {
    stores: ordered(stores.values(), (store) => refKey(store.at)),
    accesses: ordered(accesses, (access) => JSON.stringify(access)),
    calls: ordered(
      [...edges.values()].filter((call) => reaches.has(refKey(call.to))),
      (call) => `${refKey(call.from)}\n${refKey(call.to)}`,
    ),
    subscriptions: ordered(subscriptions, (subscription) => JSON.stringify(subscription)),
    impurities: ordered(impurities, (impurity) => JSON.stringify(impurity)),
  };
}
