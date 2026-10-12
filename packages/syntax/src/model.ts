/**
 * One file's tree, read into plain data: what it imports and exports, its
 * classes, functions and module variables, and for each named symbol the
 * calls, store-method calls and iterations in its body, with enough of each
 * expression kept to resolve it later against the other files. Nothing here
 * decides what a receiver is; `factsOf` does, once every file is read.
 */
import type { Node } from "web-tree-sitter";

/** A type as written: a name and its arguments. Absent when the annotation names no single type. */
export type TypeRef = { readonly name: string; readonly args: readonly (TypeRef | undefined)[] };

/** As much of an expression as resolution reads. */
export type Expr =
  | { readonly k: "name"; readonly name: string }
  | { readonly k: "this" }
  | { readonly k: "member"; readonly object: Expr; readonly property: string }
  | { readonly k: "new"; readonly ctor: Expr }
  | { readonly k: "call"; readonly callee: Expr; readonly args: readonly Expr[] }
  | { readonly k: "await"; readonly of: Expr }
  | { readonly k: "string"; readonly value: string }
  | { readonly k: "number"; readonly value: number }
  | { readonly k: "unknown" };

/** One thing a name is bound to: a declared type, a value, or something syntax cannot follow. */
export type Source =
  | { readonly k: "type"; readonly type: TypeRef | undefined }
  | { readonly k: "value"; readonly expr: Expr }
  | { readonly k: "opaque" };

/** An expiry a write carries: a deadline built from a named constant, or one that cannot be read. */
export type ExpirySeen = "unknown" | { readonly constant: string };

export type Event =
  | {
      readonly k: "call";
      readonly callee: Expr;
      readonly args: readonly Expr[];
      /** The first argument's key parts, when the method is one a keyed store has. */
      readonly key: readonly string[];
      readonly expiry?: ExpirySeen;
      readonly deferred: boolean;
    }
  | { readonly k: "iterate"; readonly of: Expr; readonly deferred: boolean }
  /** A name handed to a call as an argument: a call, if it turns out to name a function. */
  | { readonly k: "ref"; readonly target: Expr; readonly deferred: boolean };

export type SymbolModel = {
  /** The symbol as an anchor writes it. */
  readonly name: string;
  /** The named symbol whose locals it sees: itself, or the symbol an inline handler is written in. */
  readonly owner: string;
  readonly cls?: string;
  readonly callable: boolean;
  readonly async: boolean;
  readonly returns?: TypeRef;
  /** Parameters and locals by name, flat: two bindings of one name must agree or the name resolves to nothing. */
  readonly bindings: Map<string, Source[]>;
  readonly events: Event[];
};

export type SubscriptionModel = {
  readonly event: string;
  readonly via: string;
  readonly in: SymbolModel;
  readonly handler: { readonly symbol: string; readonly async: boolean } | { readonly expr: Expr };
};

export type FieldModel = { readonly sources: Source[]; readonly static: boolean };
export type ClassModel = {
  readonly name: string;
  readonly extends?: Expr;
  readonly fields: Map<string, FieldModel>;
  readonly methods: Map<string, SymbolModel>;
};

export type FileModel = {
  /** Local name → the module it comes from and its name there (`default`, or `*` for a namespace). */
  readonly imports: Map<string, { readonly from: string; readonly name: string }>;
  readonly reexports: { readonly exported: string; readonly from: string; readonly name: string }[];
  readonly stars: string[];
  /** Exported name → local name, where an export clause or a default export renames it. */
  readonly exportsAs: Map<string, string>;
  /** Every relative module this file names: imports, re-exports and literal dynamic imports. */
  readonly specifiers: Set<string>;
  readonly functions: Map<string, SymbolModel>;
  readonly variables: Map<string, Source[]>;
  readonly classes: Map<string, ClassModel>;
  /** Other top-level names (interfaces, type aliases, enums): they shadow a built-in of the same name. */
  readonly declared: Set<string>;
  readonly symbols: SymbolModel[];
  readonly subscriptions: SubscriptionModel[];
};

const FUNCTIONS = new Set([
  "arrow_function",
  "function_expression",
  "function_declaration",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
]);
const CLASSES = new Set(["class_declaration", "abstract_class_declaration", "class"]);
const LOOPS = new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]);
const TRANSPARENT = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
]);
/** The methods of a keyed store whose first argument is the key. */
const KEYED = new Set(["get", "has", "set", "add", "delete"]);
/** A callback handed to one of these runs in a later turn. */
const DEFERRING = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "requestIdleCallback",
  "nextTick",
  "waitUntil",
  "then",
  "catch",
  "finally",
  "enqueue",
  "defer",
]);
/** A written value's property with one of these words in its name is when the entry expires. */
const DEADLINE_WORDS = new Set(["expires", "expire", "expiry", "expiration", "deadline", "until"]);
const MAX_DEPTH = 12;

const field = (node: Node, name: string): Node | undefined =>
  node.childForFieldName(name) ?? undefined;
const hasToken = (node: Node, token: string): boolean =>
  node.children.some((child) => !child.isNamed && child.type === token);
const unwrap = (node: Node): Node => {
  let at = node;
  while (TRANSPARENT.has(at.type)) {
    const [inner] = at.namedChildren;
    if (inner === undefined) break;
    at = inner;
  }
  return at;
};
const wordsOf = (name: string): readonly string[] =>
  name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase());

/** A string literal's text, when it has no substitution and no escape. */
const stringOf = (node: Node): string | undefined => {
  if (node.type !== "string" && node.type !== "template_string") return undefined;
  const text = node.text.slice(1, -1);
  const plain = node.namedChildren.every((child) => child.type === "string_fragment");
  return plain && !text.includes("\\") ? text : undefined;
};

const numberOf = (node: Node): number | undefined => {
  const at = unwrap(node);
  if (at.type === "number") {
    const value = Number(at.text.replaceAll("_", ""));
    return Number.isFinite(value) ? value : undefined;
  }
  if (at.type !== "binary_expression") return undefined;
  const left = field(at, "left");
  const right = field(at, "right");
  const a = left === undefined ? undefined : numberOf(left);
  const b = right === undefined ? undefined : numberOf(right);
  if (a === undefined || b === undefined) return undefined;
  const operator = field(at, "operator")?.type;
  return operator === "*" ? a * b : operator === "+" ? a + b : undefined;
};

const toType = (node: Node | undefined): TypeRef | undefined => {
  if (node === undefined) return undefined;
  switch (node.type) {
    case "type_annotation":
    case "parenthesized_type":
      return toType(node.namedChildren[0]);
    case "type_identifier":
      return { name: node.text, args: [] };
    case "generic_type": {
      const name = field(node, "name");
      if (name?.type !== "type_identifier") return undefined;
      return {
        name: name.text,
        args: (field(node, "type_arguments")?.namedChildren ?? []).map(toType),
      };
    }
    case "union_type": {
      // `C | undefined` and `C | null` name C; any other union names no one type.
      const members = node.namedChildren.filter(
        (member) =>
          !(member.type === "literal_type" && /^(null|undefined)$/.test(member.text)) &&
          !(member.type === "predefined_type" && /^(undefined|void)$/.test(member.text)),
      );
      return members.length === 1 ? toType(members[0]) : undefined;
    }
    default:
      return undefined;
  }
};

const toExpr = (node: Node | undefined, thisOk: boolean, depth = 0): Expr => {
  if (node === undefined || depth > MAX_DEPTH) return { k: "unknown" };
  const at = unwrap(node);
  switch (at.type) {
    case "identifier":
      return { k: "name", name: at.text };
    case "this":
      return thisOk ? { k: "this" } : { k: "unknown" };
    case "member_expression": {
      const property = field(at, "property");
      if (property === undefined) return { k: "unknown" };
      return {
        k: "member",
        object: toExpr(field(at, "object"), thisOk, depth + 1),
        property: property.text,
      };
    }
    case "new_expression":
      return { k: "new", ctor: toExpr(field(at, "constructor"), thisOk, depth + 1) };
    case "call_expression":
      return {
        k: "call",
        callee: toExpr(field(at, "function"), thisOk, depth + 1),
        args: (field(at, "arguments")?.namedChildren ?? [])
          .slice(0, 3)
          .map((arg) => toExpr(arg, thisOk, depth + 1)),
      };
    case "await_expression":
      return { k: "await", of: toExpr(at.namedChildren[0], thisOk, depth + 1) };
    case "string":
    case "template_string": {
      const value = stringOf(at);
      return value === undefined ? { k: "unknown" } : { k: "string", value };
    }
    default: {
      const value = numberOf(at);
      return value === undefined ? { k: "unknown" } : { k: "number", value };
    }
  }
};

/** The names a binding pattern declares. */
const namesIn = (pattern: Node | undefined): readonly string[] => {
  if (pattern === undefined) return [];
  switch (pattern.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return [pattern.text];
    case "pair_pattern":
      return namesIn(field(pattern, "value"));
    case "assignment_pattern":
    case "object_assignment_pattern":
      return namesIn(field(pattern, "left"));
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      return pattern.namedChildren.flatMap(namesIn);
    default:
      return [];
  }
};

/** `a.b.c` as written, `?.` as `.`; absent when the chain passes through anything but names. */
const pathOf = (node: Node): string | undefined => {
  const at = unwrap(node);
  if (at.type === "identifier" || at.type === "this") return at.text;
  if (at.type !== "member_expression") return undefined;
  const object = field(at, "object");
  const property = field(at, "property");
  const head = object === undefined ? undefined : pathOf(object);
  return head === undefined || property === undefined ? undefined : `${head}.${property.text}`;
};

/** What a symbol's body binds, gathered before its events are read. */
type Scope = {
  readonly model: SymbolModel;
  /** A local's initialisers, kept while the tree lives, to read a key or an expiry through it. */
  readonly inits: Map<string, Node[]>;
  readonly assigned: [string, Source][];
  /** Local names handed to a deferring call: a function bound to one runs later. */
  readonly deferredNames: Set<string>;
  readonly fields?: Map<string, FieldModel>;
  readonly top: ReadonlySet<string>;
};

const bind = (scope: Scope, name: string, source: Source): void => {
  const sources = scope.model.bindings.get(name);
  if (sources === undefined) scope.model.bindings.set(name, [source]);
  else sources.push(source);
};

const fieldSource = (fields: Map<string, FieldModel>, name: string, source: Source): void => {
  const known = fields.get(name);
  if (known === undefined) fields.set(name, { sources: [source], static: false });
  else known.sources.push(source);
};

const isDeferring = (callee: Node | undefined): boolean => {
  if (callee === undefined) return false;
  const at = unwrap(callee);
  const name = at.type === "member_expression" ? field(at, "property")?.text : at.text;
  return name !== undefined && DEFERRING.has(name);
};

const bindParameters = (scope: Scope, fn: Node, isConstructor: boolean): void => {
  const single = field(fn, "parameter");
  if (single !== undefined) bind(scope, single.text, { k: "opaque" });
  for (const parameter of field(fn, "parameters")?.namedChildren ?? []) {
    const pattern = field(parameter, "pattern");
    const type = field(parameter, "type");
    const value = field(parameter, "value");
    if (pattern?.type !== "identifier") {
      for (const name of namesIn(pattern)) bind(scope, name, { k: "opaque" });
      continue;
    }
    const source: Source =
      type !== undefined
        ? { k: "type", type: toType(type) }
        : value !== undefined
          ? { k: "value", expr: toExpr(value, false) }
          : { k: "opaque" };
    bind(scope, pattern.text, source);
    // `constructor(private readonly cache: RoleCache)` declares the field too.
    const isProperty =
      parameter.namedChildren.some((child) => child.type === "accessibility_modifier") ||
      hasToken(parameter, "readonly");
    if (isConstructor && isProperty && scope.fields !== undefined)
      fieldSource(scope.fields, pattern.text, source);
  }
};

const collect = (scope: Scope, node: Node, thisOk: boolean): void => {
  if (CLASSES.has(node.type)) return;
  if (FUNCTIONS.has(node.type)) {
    const name = node.type.endsWith("_declaration") ? field(node, "name") : undefined;
    if (name !== undefined) bind(scope, name.text, { k: "opaque" });
    bindParameters(scope, node, false);
    const body = field(node, "body");
    if (body !== undefined) collect(scope, body, node.type === "arrow_function" && thisOk);
    return;
  }
  switch (node.type) {
    case "variable_declarator": {
      const name = field(node, "name");
      const type = field(node, "type");
      const value = field(node, "value");
      if (name?.type === "identifier") {
        if (type !== undefined) bind(scope, name.text, { k: "type", type: toType(type) });
        if (value !== undefined) {
          bind(scope, name.text, { k: "value", expr: toExpr(value, thisOk) });
          scope.inits.set(name.text, [...(scope.inits.get(name.text) ?? []), value]);
        }
        if (type === undefined && value === undefined) bind(scope, name.text, { k: "opaque" });
      } else for (const bound of namesIn(name)) bind(scope, bound, { k: "opaque" });
      break;
    }
    case "assignment_expression":
    case "augmented_assignment_expression": {
      const left = field(node, "left");
      const right = field(node, "right");
      const source: Source =
        node.type === "assignment_expression"
          ? { k: "value", expr: toExpr(right, thisOk) }
          : { k: "opaque" };
      if (left?.type === "identifier") scope.assigned.push([left.text, source]);
      else if (left?.type === "member_expression" && thisOk && scope.fields !== undefined) {
        const property = field(left, "property");
        if (field(left, "object")?.type === "this" && property !== undefined)
          fieldSource(scope.fields, property.text, source);
      }
      break;
    }
    case "for_in_statement": {
      const declares = ["const", "let", "var"].some((kind) => hasToken(node, kind));
      for (const name of namesIn(field(node, "left")))
        if (declares) bind(scope, name, { k: "opaque" });
        else scope.assigned.push([name, { k: "opaque" }]);
      break;
    }
    case "catch_clause":
      for (const name of namesIn(field(node, "parameter"))) bind(scope, name, { k: "opaque" });
      break;
    case "call_expression":
      if (isDeferring(field(node, "function")))
        for (const arg of field(node, "arguments")?.namedChildren ?? [])
          if (arg.type === "identifier") scope.deferredNames.add(arg.text);
      break;
    default:
  }
  for (const child of node.namedChildren) collect(scope, child, thisOk);
};

/** A local bound once, by its declaration: a key or an expiry is read through it. */
const followed = (scope: Scope, node: Node): Node => {
  if (node.type !== "identifier") return node;
  const inits = scope.inits.get(node.text);
  const [init] = inits ?? [];
  return init !== undefined &&
    inits?.length === 1 &&
    scope.model.bindings.get(node.text)?.length === 1
    ? init
    : node;
};

/** The identifier paths a key is built from, in the order written. */
const keyParts = (scope: Scope, node: Node, seen: ReadonlySet<string> = new Set()): string[] => {
  const at = unwrap(node);
  const each = (nodes: readonly (Node | undefined)[]): string[] =>
    nodes.flatMap((child) => (child === undefined ? [] : keyParts(scope, child, seen)));
  switch (at.type) {
    case "identifier": {
      const init = seen.has(at.text) ? at : followed(scope, at);
      const through = init === at ? [] : keyParts(scope, init, new Set([...seen, at.text]));
      // A local bound to something with no names in it (a function, a literal) is its own part.
      return through.length === 0 ? [at.text] : through;
    }
    case "this":
      return ["this"];
    case "member_expression": {
      const path = pathOf(at);
      return path === undefined ? each([field(at, "object")]) : [path];
    }
    case "subscript_expression":
      return each([field(at, "object"), field(at, "index")]);
    case "template_string":
      return each(at.namedChildren.flatMap((child) => child.namedChildren));
    case "binary_expression":
      return each([field(at, "left"), field(at, "right")]);
    case "ternary_expression":
      return each([field(at, "consequence"), field(at, "alternative")]);
    case "await_expression":
    case "array":
    case "spread_element":
      return each(at.namedChildren);
    case "object":
      return each(
        at.namedChildren.map((child) => (child.type === "pair" ? field(child, "value") : child)),
      );
    case "shorthand_property_identifier":
      return [at.text];
    case "call_expression": {
      // A helper that builds the key: its arguments are the parts, and so is
      // what a method is called on, unless that is a global (`JSON`, `String`).
      const callee = field(at, "function");
      const object = callee?.type === "member_expression" ? field(callee, "object") : undefined;
      const root = object === undefined ? undefined : pathOf(object)?.split(".")[0];
      const known =
        root !== undefined &&
        (root === "this" || scope.model.bindings.has(root) || scope.top.has(root));
      return each([known ? object : undefined, ...(field(at, "arguments")?.namedChildren ?? [])]);
    }
    default:
      return [];
  }
};

/** When a written value says its entry expires: `{ expiresAt: now + TTL_MS }`. */
const expiryOf = (scope: Scope, node: Node): ExpirySeen | undefined => {
  const value = unwrap(followed(scope, unwrap(node)));
  if (value.type !== "object") return undefined;
  for (const property of value.namedChildren) {
    const key = property.type === "pair" ? field(property, "key") : property;
    if (key === undefined || !wordsOf(key.text).some((word) => DEADLINE_WORDS.has(word))) continue;
    const written = property.type === "pair" ? field(property, "value") : property;
    const deadline = written === undefined ? undefined : unwrap(followed(scope, unwrap(written)));
    if (deadline?.type !== "binary_expression" || field(deadline, "operator")?.type !== "+")
      return "unknown";
    const terms = [field(deadline, "left"), field(deadline, "right")].flatMap((term) =>
      term !== undefined && unwrap(term).type === "identifier" ? [unwrap(term).text] : [],
    );
    // `now + TTL_MS`: the duration is the term whose name ends in a unit.
    const constant = terms.find((name) => unitOf(name) !== undefined);
    return constant === undefined ? "unknown" : { constant };
  }
  return undefined;
};

/** Seconds per unit of a duration named with a unit suffix (`TTL_MS`, `lifetimeSeconds`). */
export const unitOf = (name: string): number | undefined => {
  switch (wordsOf(name).at(-1)) {
    case "ms":
    case "millis":
    case "milliseconds":
      return 1 / 1000;
    case "s":
    case "sec":
    case "secs":
    case "seconds":
      return 1;
    case "min":
    case "mins":
    case "minutes":
      return 60;
    case "h":
    case "hours":
      return 3600;
    default:
      return undefined;
  }
};

/** An `await` (or a `yield`) in a function: where it is, and the loop it sits in, if any. */
type Pause = {
  readonly start: number;
  readonly end: number;
  readonly loop?: readonly [number, number];
};
type Level = { readonly fn: Node; pauses?: readonly Pause[] };

const pausesIn = (fn: Node): readonly Pause[] => {
  const found: Pause[] = [];
  const visit = (node: Node, loop: readonly [number, number] | undefined): void => {
    if (node !== fn && (FUNCTIONS.has(node.type) || CLASSES.has(node.type))) return;
    const inside = loop ?? (LOOPS.has(node.type) ? [node.startIndex, node.endIndex] : undefined);
    const mark = (start: number, end: number): void => {
      found.push(inside === undefined ? { start, end } : { start, end, loop: inside });
    };
    if (node.type === "await_expression" || node.type === "yield_expression")
      mark(node.startIndex, node.endIndex);
    if (node.type === "for_in_statement" && hasToken(node, "await"))
      mark(node.startIndex, field(node, "body")?.startIndex ?? node.endIndex);
    for (const child of node.namedChildren) visit(child, inside);
  };
  visit(fn, undefined);
  return found;
};

/** `node` runs after a pause in `level`'s function: one completes before it does, or shares a loop with it. */
const pausedBefore = (level: Level, node: Node): boolean => {
  level.pauses ??= pausesIn(level.fn);
  return level.pauses.some(
    (pause) =>
      (pause.loop !== undefined &&
        pause.loop[0] <= node.startIndex &&
        node.endIndex <= pause.loop[1]) ||
      (pause.end <= node.endIndex &&
        !(pause.start <= node.startIndex && node.endIndex <= pause.end)),
  );
};

type Context = {
  readonly file: FileModel;
  readonly registrars: ReadonlySet<string>;
  readonly scope: Scope;
  /** The symbol the events belong to: the scope's own, or an inline handler in it. */
  readonly sym: SymbolModel;
  /** The functions around the node, outermost first, up to the symbol's own. */
  readonly levels: readonly Level[];
  /** Inside a callback a deferring call was given. */
  readonly later: boolean;
  readonly thisOk: boolean;
};

const deferredAt = (context: Context, node: Node): boolean =>
  context.later ||
  context.levels.some((level, index) => pausedBefore(level, context.levels[index + 1]?.fn ?? node));

const enter = (context: Context, fn: Node, later: boolean): void => {
  const body = field(fn, "body");
  if (body === undefined) return;
  emit(
    {
      ...context,
      levels: [...context.levels, { fn }],
      later: context.later || later,
      thisOk: fn.type === "arrow_function" && context.thisOk,
    },
    body,
  );
};

const emitCall = (context: Context, node: Node): void => {
  const isNew = node.type === "new_expression";
  const callee = field(node, isNew ? "constructor" : "function");
  const args = field(node, "arguments")?.namedChildren ?? [];
  const calleeAt = callee === undefined ? undefined : unwrap(callee);
  const method =
    calleeAt?.type === "member_expression" ? field(calleeAt, "property")?.text : calleeAt?.text;
  const [first, second] = args;

  if (calleeAt?.type === "import") {
    const specifier = first === undefined ? undefined : stringOf(first);
    if (specifier?.startsWith(".") === true) context.file.specifiers.add(specifier);
    return;
  }

  // A registrar called with an event's name and a function is a subscription.
  const event = first === undefined ? undefined : stringOf(first);
  if (
    !isNew &&
    method !== undefined &&
    context.registrars.has(method) &&
    event !== undefined &&
    second !== undefined
  ) {
    if (FUNCTIONS.has(second.type)) {
      const handler: SymbolModel = {
        name: `${context.sym.name}~${event}`,
        owner: context.sym.owner,
        ...(context.sym.cls === undefined ? {} : { cls: context.sym.cls }),
        callable: true,
        async: hasToken(second, "async"),
        bindings: context.scope.model.bindings,
        events: [],
      };
      context.file.symbols.push(handler);
      context.file.subscriptions.push({
        event,
        via: method,
        in: context.sym,
        handler: { symbol: handler.name, async: handler.async },
      });
      const body = field(second, "body");
      // The handler runs when the event fires: what came before its registration does not defer it.
      if (body !== undefined)
        emit(
          {
            ...context,
            sym: handler,
            levels: [{ fn: second }],
            later: false,
            thisOk: second.type === "arrow_function" && context.thisOk,
          },
          body,
        );
    } else
      context.file.subscriptions.push({
        event,
        via: method,
        in: context.sym,
        handler: { expr: toExpr(second, context.thisOk) },
      });
    if (callee !== undefined) emit(context, callee);
    for (const arg of args.slice(2)) emit(context, arg);
    return;
  }

  const deferred = deferredAt(context, node);
  const keyed = !isNew && calleeAt?.type === "member_expression" && method !== undefined;
  const expiry =
    keyed && method === "set" && second !== undefined ? expiryOf(context.scope, second) : undefined;
  context.sym.events.push({
    k: "call",
    callee: isNew
      ? { k: "new", ctor: toExpr(callee, context.thisOk) }
      : toExpr(callee, context.thisOk),
    args: args.slice(0, 3).map((arg) => toExpr(arg, context.thisOk)),
    key: keyed && KEYED.has(method) && first !== undefined ? keyParts(context.scope, first) : [],
    ...(expiry === undefined ? {} : { expiry }),
    deferred,
  });

  const later = isDeferring(callee);
  for (const arg of args) {
    if (FUNCTIONS.has(arg.type)) {
      enter(context, arg, later);
      continue;
    }
    const named =
      arg.type === "identifier" ||
      (arg.type === "member_expression" && field(arg, "object")?.type === "this");
    if (named)
      context.sym.events.push({
        k: "ref",
        target: toExpr(arg, context.thisOk),
        deferred: deferred || later,
      });
    emit(context, arg);
  }
  if (callee !== undefined) emit(context, callee);
};

function emit(context: Context, node: Node): void {
  if (CLASSES.has(node.type)) return;
  if (FUNCTIONS.has(node.type)) {
    // A function bound to a local name runs later when that name was handed to a deferring call.
    const name = node.type.endsWith("_declaration") ? field(node, "name")?.text : undefined;
    enter(context, node, name !== undefined && context.scope.deferredNames.has(name));
    return;
  }
  switch (node.type) {
    case "call_expression":
    case "new_expression":
      emitCall(context, node);
      return;
    case "variable_declarator": {
      const name = field(node, "name");
      const value = field(node, "value");
      if (value !== undefined && FUNCTIONS.has(value.type)) {
        enter(
          context,
          value,
          name?.type === "identifier" && context.scope.deferredNames.has(name.text),
        );
        return;
      }
      break;
    }
    case "for_in_statement": {
      const right = field(node, "right");
      if (hasToken(node, "of") && right !== undefined)
        context.sym.events.push({
          k: "iterate",
          of: toExpr(right, context.thisOk),
          deferred: deferredAt(context, right),
        });
      break;
    }
    case "spread_element": {
      const [spread] = node.namedChildren;
      if (spread !== undefined)
        context.sym.events.push({
          k: "iterate",
          of: toExpr(spread, context.thisOk),
          deferred: deferredAt(context, spread),
        });
      break;
    }
    default:
  }
  for (const child of node.namedChildren) emit(context, child);
}

/**
 * Whether the tree nests deeper than `levels`. The reader below follows a
 * tree by recursion, so a file nested without end (two thousand calls inside
 * each other are six kilobytes) would otherwise end it with a stack overflow,
 * at a depth that differs from one runtime to the next. Walked with a cursor,
 * which keeps no stack of its own.
 */
export function nestsBeyond(root: Node, levels: number): boolean {
  const cursor = root.walk();
  try {
    let depth = 0;
    for (;;) {
      if (cursor.gotoFirstChild()) {
        depth += 1;
        if (depth > levels) return true;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return false;
        depth -= 1;
      }
    }
  } finally {
    cursor.delete();
  }
}

type Build = { readonly file: FileModel; readonly registrars: ReadonlySet<string> };

/** Reads one named symbol: `fn` when it is a function, otherwise the expression that initialises it. */
const symbolOf = (
  build: Build,
  name: string,
  node: Node,
  cls?: { readonly name: string; readonly fields: Map<string, FieldModel> },
): SymbolModel => {
  const callable = FUNCTIONS.has(node.type);
  const returns = callable ? toType(field(node, "return_type")) : undefined;
  const model: SymbolModel = {
    name,
    owner: name,
    ...(cls === undefined ? {} : { cls: cls.name }),
    callable,
    async: callable && hasToken(node, "async"),
    ...(returns === undefined ? {} : { returns }),
    bindings: new Map(),
    events: [],
  };
  const scope: Scope = {
    model,
    inits: new Map(),
    assigned: [],
    deferredNames: new Set(),
    ...(cls === undefined ? {} : { fields: cls.fields }),
    top: new Set([
      ...build.file.imports.keys(),
      ...build.file.functions.keys(),
      ...build.file.variables.keys(),
      ...build.file.classes.keys(),
    ]),
  };
  const thisOk = cls !== undefined;
  const body = callable ? field(node, "body") : node;
  if (callable) bindParameters(scope, node, name === `${cls?.name}.constructor`);
  if (body !== undefined) collect(scope, body, thisOk);
  // An assignment is another binding of a local, and nothing to a name the symbol does not declare.
  for (const [assigned, source] of scope.assigned)
    if (model.bindings.has(assigned)) bind(scope, assigned, source);
  build.file.symbols.push(model);
  if (body !== undefined)
    emit(
      {
        file: build.file,
        registrars: build.registrars,
        scope,
        sym: model,
        levels: callable ? [{ fn: node }] : [],
        later: false,
        thisOk,
      },
      body,
    );
  return model;
};

const classOf = (build: Build, node: Node, name: string): ClassModel => {
  const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
  const base = heritage?.namedChildren.find((child) => child.type === "extends_clause");
  const model: ClassModel = {
    name,
    ...(base === undefined ? {} : { extends: toExpr(field(base, "value"), false) }),
    fields: new Map(),
    methods: new Map(),
  };
  build.file.classes.set(name, model);
  const members = field(node, "body")?.namedChildren ?? [];
  const named = (member: Node): string | undefined => {
    const id = field(member, "name");
    return id?.type === "property_identifier" || id?.type === "private_property_identifier"
      ? id.text
      : undefined;
  };
  // Fields first: a method that assigns `this.f` adds to the field's bindings.
  const later: [string, Node][] = [];
  for (const member of members) {
    const id = named(member);
    if (id === undefined || member.type !== "public_field_definition") continue;
    const type = field(member, "type");
    const value = field(member, "value");
    const sources: Source[] = [];
    if (type !== undefined) sources.push({ k: "type", type: toType(type) });
    if (value !== undefined) {
      sources.push({ k: "value", expr: toExpr(value, true) });
      later.push([id, value]);
    }
    if (sources.length === 0) sources.push({ k: "opaque" });
    model.fields.set(id, { sources, static: hasToken(member, "static") });
  }
  for (const [id, value] of later) {
    const symbol = symbolOf(build, `${name}.${id}`, value, model);
    if (symbol.callable) model.methods.set(id, symbol);
  }
  for (const member of members) {
    const id = named(member);
    if (id === undefined || member.type !== "method_definition" || model.methods.has(id)) continue;
    model.methods.set(id, symbolOf(build, `${name}.${id}`, member, model));
  }
  return model;
};

/** Reads a parsed file. `registrars` are the method names that register an event handler. */
export function modelOf(root: Node, registrars: ReadonlySet<string>): FileModel {
  const file: FileModel = {
    imports: new Map(),
    reexports: [],
    stars: [],
    exportsAs: new Map(),
    specifiers: new Set(),
    functions: new Map(),
    variables: new Map(),
    classes: new Map(),
    declared: new Set(),
    symbols: [],
    subscriptions: [],
  };
  const build: Build = { file, registrars };
  const relative = (from: string): void => {
    if (from.startsWith(".")) file.specifiers.add(from);
  };
  const declarations: Node[] = [];

  for (const statement of root.namedChildren) {
    const source = field(statement, "source");
    const from = source === undefined ? undefined : stringOf(source);
    if (statement.type === "import_statement") {
      if (from === undefined) continue;
      relative(from);
      const clause = statement.namedChildren.find((child) => child.type === "import_clause");
      for (const part of clause?.namedChildren ?? []) {
        if (part.type === "identifier") file.imports.set(part.text, { from, name: "default" });
        if (part.type === "namespace_import")
          for (const id of part.namedChildren) file.imports.set(id.text, { from, name: "*" });
        if (part.type === "named_imports")
          for (const specifier of part.namedChildren) {
            const name = field(specifier, "name");
            if (name !== undefined)
              file.imports.set((field(specifier, "alias") ?? name).text, { from, name: name.text });
          }
      }
      continue;
    }
    if (statement.type !== "export_statement") {
      declarations.push(statement);
      continue;
    }
    const clause = statement.namedChildren.find((child) => child.type === "export_clause");
    for (const specifier of clause?.namedChildren ?? []) {
      const name = field(specifier, "name");
      if (name === undefined) continue;
      const exported = (field(specifier, "alias") ?? name).text;
      if (from === undefined) file.exportsAs.set(exported, name.text);
      else file.reexports.push({ exported, from, name: name.text });
    }
    if (from !== undefined) {
      relative(from);
      if (clause === undefined && hasToken(statement, "*")) file.stars.push(from);
      continue;
    }
    const declaration = field(statement, "declaration");
    const value = field(statement, "value");
    const isDefault = hasToken(statement, "default");
    if (isDefault && value?.type === "identifier") file.exportsAs.set("default", value.text);
    if (declaration === undefined) continue;
    const name = field(declaration, "name");
    if (isDefault && name !== undefined) file.exportsAs.set("default", name.text);
    declarations.push(declaration);
  }

  // Module variables and the names of functions and classes first, so a body sees every top-level name.
  const bodies: (() => void)[] = [];
  for (const declaration of declarations) {
    const name = field(declaration, "name")?.text;
    switch (declaration.type) {
      case "function_declaration":
      case "generator_function_declaration":
        if (name !== undefined)
          bodies.push(() => file.functions.set(name, symbolOf(build, name, declaration)));
        break;
      case "class_declaration":
      case "abstract_class_declaration":
        if (name !== undefined) bodies.push(() => void classOf(build, declaration, name));
        break;
      case "lexical_declaration":
      case "variable_declaration":
        for (const declarator of declaration.namedChildren) {
          const id = field(declarator, "name");
          if (declarator.type !== "variable_declarator" || id?.type !== "identifier") continue;
          const type = field(declarator, "type");
          const value = field(declarator, "value");
          const sources: Source[] = [];
          if (type !== undefined) sources.push({ k: "type", type: toType(type) });
          if (value !== undefined) {
            sources.push({ k: "value", expr: toExpr(value, false) });
            bodies.push(() => {
              const symbol = symbolOf(build, id.text, value);
              if (symbol.callable) file.functions.set(id.text, symbol);
            });
          }
          if (sources.length === 0) sources.push({ k: "opaque" });
          file.variables.set(id.text, sources);
        }
        break;
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration":
        if (name !== undefined) file.declared.add(name);
        break;
      default:
    }
  }
  // Names before bodies: `top` is read when a body's key parts are.
  for (const declaration of declarations) {
    const name = field(declaration, "name")?.text;
    if (name === undefined) continue;
    if (declaration.type.endsWith("function_declaration")) file.declared.add(name);
    if (declaration.type.endsWith("class_declaration")) file.declared.add(name);
  }
  for (const body of bodies) body();
  return file;
}
