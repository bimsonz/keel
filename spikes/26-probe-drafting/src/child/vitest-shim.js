/* oxlint-disable no-shadow -- suite/test parameters mirror vitest's own runner naming */
/* oxlint-disable no-underscore-dangle -- __keel is the harness entry the generated code calls */
// A vitest 5 API subset for running test files inside a Worker isolate.
//
// `expect` is the real @vitest/expect 5 + chai stack wired the way vitest's own
// `createExpect` wires it. The runner (describe/it/hooks/modes/each) is a small
// re-implementation of vitest's collection and run semantics. Snapshots, fake
// timers, module mocking and expect.poll are not supported and throw.
import * as chai from "chai";
import {
  ASYMMETRIC_MATCHERS_OBJECT,
  ChaiStyleAssertions,
  GLOBAL_EXPECT,
  JestAsymmetricMatchers,
  JestChaiExpect,
  JestExtend,
  addCustomEqualityTesters,
  customMatchers,
  getState,
  setState,
} from "@vitest/expect";
import * as spy from "@vitest/spy";
import { format, formatRegExp, inspect, truncateString } from "@vitest/utils/display";
import { isNegativeNaN, isObject, objectAttr, toArray } from "@vitest/utils/helpers";

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(ChaiStyleAssertions);
chai.use(JestAsymmetricMatchers);

const TEST_TIMEOUT = 5000;
const HOOK_TIMEOUT = 10000;
const TITLE_TRUNCATE = 40;

let currentTest = null;

function createExpect() {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- refers to itself via getState(expect)
  const expect = (value, message) => {
    const { assertionCalls } = getState(expect);
    setState({ assertionCalls: assertionCalls + 1 }, expect);
    const assert = chai.expect(value, message);
    return currentTest ? assert.withTest(currentTest) : assert;
  };
  Object.assign(expect, chai.expect);
  Object.assign(expect, globalThis[ASYMMETRIC_MATCHERS_OBJECT]);
  expect.getState = () => getState(expect);
  expect.setState = (state) => setState(state, expect);
  setState(freshState(""), expect);
  expect.assert = chai.assert;
  expect.extend = (matchers) => chai.expect.extend(expect, matchers);
  expect.addEqualityTesters = (testers) => addCustomEqualityTesters(testers);
  expect.soft = (...args) => expect(...args).withContext({ soft: true });
  expect.poll = () => {
    throw new Error("expect.poll is not supported in Tier 1");
  };
  expect.unreachable = (message) => {
    chai.assert.fail(`expected${message ? ` "${message}" ` : " "}not to be reached`);
  };
  function assertions(expected) {
    const errorGen = () =>
      new Error(
        `expected number of assertions to be ${expected}, but got ${expect.getState().assertionCalls}`,
      );
    expect.setState({ expectedAssertionsNumber: expected, expectedAssertionsNumberErrorGen: errorGen });
  }
  function hasAssertions() {
    const error = new Error("expected any number of assertion, but got none");
    expect.setState({ isExpectingAssertions: true, isExpectingAssertionsError: error });
  }
  chai.util.addMethod(expect, "assertions", assertions);
  chai.util.addMethod(expect, "hasAssertions", hasAssertions);
  expect.extend(customMatchers);
  return expect;
}

function freshState(name) {
  return {
    assertionCalls: 0,
    isExpectingAssertions: false,
    isExpectingAssertionsError: null,
    expectedAssertionsNumber: null,
    expectedAssertionsNumberErrorGen: null,
    currentTestName: name,
  };
}

export const expect = createExpect();
Object.defineProperty(globalThis, GLOBAL_EXPECT, { value: expect, writable: true, configurable: true });
export const assert = chai.assert;
export const should = chai.should;
export { chai };

// ---------------------------------------------------------------------------
// Collection

function newSuite(name, mode, parent, factory, options) {
  return {
    type: "suite",
    name,
    mode,
    parent,
    factory,
    options: options ?? {},
    tasks: [],
    hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] },
    containsOnly: false,
  };
}

let root = newSuite("", "run", null, null);
let collectingSuite = root;

function formatName(name) {
  if (typeof name === "string") return name;
  if (typeof name === "function") return name.name || "<anonymous>";
  return String(name);
}

function parseArguments(optionsOrFn, fnOrOptions) {
  if (typeof optionsOrFn === "function") {
    const options = typeof fnOrOptions === "number" ? { timeout: fnOrOptions } : (fnOrOptions ?? {});
    return { options, handler: optionsOrFn };
  }
  if (typeof optionsOrFn === "number") return { options: { timeout: optionsOrFn }, handler: fnOrOptions };
  return { options: optionsOrFn ?? {}, handler: fnOrOptions };
}

function modeOf(flags, options, hasHandler) {
  let mode = flags.only || options.only ? "only" : flags.skip || options.skip ? "skip" : flags.todo || options.todo ? "todo" : "run";
  if (mode === "run" && !hasHandler) mode = "todo";
  return mode;
}

function registerTest(flags, name, optionsOrFn, fnOrOptions) {
  const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
  collectingSuite.tasks.push({
    type: "test",
    name: formatName(name),
    mode: modeOf(flags, options, Boolean(handler)),
    parent: collectingSuite,
    fn: handler,
    fails: Boolean(flags.fails || options.fails),
    timeout: options.timeout ?? TEST_TIMEOUT,
    retry: options.retry ?? 0,
    repeats: options.repeats ?? 0,
  });
}

function registerSuite(flags, name, optionsOrFn, fnOrOptions) {
  const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
  const mode = modeOf(flags, options, Boolean(handler));
  collectingSuite.tasks.push(newSuite(formatName(name), mode, collectingSuite, handler, options));
}

// vitest's formatTitle, reproduced on @vitest/utils so `.each` names match.
function formatTitle(template, items, idx) {
  if (template.includes("%#") || template.includes("%$")) {
    template = template
      .replace(/%%/g, "__vitest_escaped_%__")
      .replace(/%#/g, `${idx}`)
      .replace(/%\$/g, `${idx + 1}`)
      .replace(/__vitest_escaped_%__/g, "%%");
  }
  const count = template.split("%").length - 1;
  if (template.includes("%f")) {
    (template.match(/%f/g) || []).forEach((_, i) => {
      if (isNegativeNaN(items[i]) || Object.is(items[i], -0)) {
        let occurrence = 0;
        template = template.replace(/%f/g, (match) => {
          occurrence++;
          return occurrence === i + 1 ? "-%f" : match;
        });
      }
    });
  }
  const inspectOptions = { truncate: TITLE_TRUNCATE };
  const isObjectItem = isObject(items[0]);
  function formatAttribute(s) {
    return s.replace(/\$([$\p{ID_Continue}.]+)/gu, (_, key) => {
      const isArrayKey = /^\d+$/.test(key);
      if (!isObjectItem && !isArrayKey) return `$${key}`;
      const arrayElement = isArrayKey ? objectAttr(items, key) : undefined;
      const value = isObjectItem ? objectAttr(items[0], key, arrayElement) : arrayElement;
      if (typeof value === "string") return truncateString(value, inspectOptions.truncate);
      return inspect(value, inspectOptions);
    });
  }
  let output = "";
  let i = 0;
  let lastIndex = 0;
  for (const m of template.matchAll(formatRegExp)) {
    if (lastIndex < m.index) output += formatAttribute(template.slice(lastIndex, m.index));
    if (i < count) output += format([m[0], items[i++]], inspectOptions);
    else output += m[0];
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < template.length) output += formatAttribute(template.slice(lastIndex));
  return output;
}

function formatTemplateString(cases, args) {
  const header = cases.join("").trim().replace(/ /g, "").split("\n").map((i) => i.split("|"))[0];
  const res = [];
  for (let i = 0; i < Math.floor(args.length / header.length); i++) {
    const oneCase = {};
    for (let j = 0; j < header.length; j++) oneCase[header[j]] = args[i * header.length + j];
    res.push(oneCase);
  }
  return res;
}

function makeEach(register) {
  return (cases, ...args) => {
    if (Array.isArray(cases) && args.length) cases = formatTemplateString(cases, args);
    return (name, optionsOrFn, fnOrOptions) => {
      const title = formatName(name);
      const arrayOnlyCases = cases.every(Array.isArray);
      const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
      cases.forEach((c, idx) => {
        const items = Array.isArray(c) ? c : [c];
        const bound = handler ? (arrayOnlyCases ? () => handler(...items) : () => handler(c)) : undefined;
        register(formatTitle(title, items, idx), options, bound);
      });
    };
  };
}

function makeFor(register) {
  return (cases, ...args) => {
    if (Array.isArray(cases) && args.length) cases = formatTemplateString(cases, args);
    return (name, optionsOrFn, fnOrOptions) => {
      const title = formatName(name);
      const { options, handler } = parseArguments(optionsOrFn, fnOrOptions);
      cases.forEach((item, idx) => {
        const bound = handler ? (ctx) => handler(item, ctx) : undefined;
        register(formatTitle(title, toArray(item), idx), options, bound);
      });
    };
  };
}

function chainable(registerFn, flags) {
  const api = (name, a, b) => registerFn(flags, name, a, b);
  for (const key of ["skip", "only", "todo", "concurrent", "sequential", "fails", "shuffle"]) {
    Object.defineProperty(api, key, { get: () => chainable(registerFn, { ...flags, [key]: true }) });
  }
  api.each = makeEach((n, o, f) => registerFn(flags, n, o, f));
  api.for = makeFor((n, o, f) => registerFn(flags, n, o, f));
  api.skipIf = (condition) => (condition ? api.skip : api);
  api.runIf = (condition) => (condition ? api : api.skip);
  api.extend = () => {
    throw new Error("test.extend is not supported in Tier 1");
  };
  return api;
}

export const test = chainable(registerTest, {});
export const it = test;
export const describe = chainable(registerSuite, {});
export const suite = describe;

function hook(kind) {
  return (fn, timeout) => {
    collectingSuite.hooks[kind].push({ fn, timeout: timeout ?? HOOK_TIMEOUT });
  };
}
export const beforeAll = hook("beforeAll");
export const afterAll = hook("afterAll");
export const beforeEach = hook("beforeEach");
export const afterEach = hook("afterEach");
export function onTestFinished(fn) {
  if (!currentTest) throw new Error("onTestFinished called outside a test");
  currentTest.onFinished.push(fn);
}
export function onTestFailed(fn) {
  if (!currentTest) throw new Error("onTestFailed called outside a test");
  currentTest.onFailed.push(fn);
}
export function expectTypeOf() {
  const self = new Proxy(() => self, { get: () => self, apply: () => self });
  return self;
}
export function assertType() {}
export function inject() {
  return undefined;
}

const stubbedGlobals = new Map();
export const vi = {
  fn: spy.fn,
  spyOn: spy.spyOn,
  isMockFunction: spy.isMockFunction,
  restoreAllMocks: () => (spy.restoreAllMocks(), vi),
  clearAllMocks: () => (spy.clearAllMocks(), vi),
  resetAllMocks: () => (spy.resetAllMocks(), vi),
  mocked: (x) => x,
  stubGlobal(name, value) {
    if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
    return vi;
  },
  unstubAllGlobals() {
    for (const [name, desc] of stubbedGlobals) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
    stubbedGlobals.clear();
    return vi;
  },
  useFakeTimers() {
    throw new Error("vi.useFakeTimers is not supported in Tier 1");
  },
  useRealTimers: () => vi,
  mock() {
    throw new Error("vi.mock is not supported in Tier 1");
  },
  hoisted: (factory) => factory(),
  waitFor: async (cb, opts) => {
    const timeout = typeof opts === "number" ? opts : (opts?.timeout ?? 1000);
    const interval = typeof opts === "object" ? (opts?.interval ?? 50) : 50;
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        return await cb();
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, interval));
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Running

async function collect(suite) {
  if (suite.factory) {
    const prev = collectingSuite;
    collectingSuite = suite;
    try {
      await suite.factory();
    } finally {
      collectingSuite = prev;
    }
  }
  let containsOnly = false;
  for (const child of suite.tasks) {
    if (child.type === "suite") await collect(child);
    if (child.mode === "only" || (child.type === "suite" && child.containsOnly)) containsOnly = true;
  }
  suite.containsOnly = containsOnly;
}

function skipAll(suite, to) {
  for (const t of suite.tasks) {
    if (t.mode === "run") {
      t.mode = to;
      if (t.type === "suite") skipAll(t, to);
    }
  }
}

// vitest's interpretTaskModes (no name/location/tag filters).
function interpretModes(suite, onlyMode, parentIsOnly) {
  const suiteIsOnly = parentIsOnly || suite.mode === "only";
  const hasSomeTasksOnly = Boolean(onlyMode && suite.containsOnly);
  for (const t of suite.tasks) {
    const includeTask = hasSomeTasksOnly
      ? t.mode === "only" || (t.type === "suite" && t.containsOnly)
      : suiteIsOnly || t.mode === "only";
    if (onlyMode) {
      if (t.type === "suite" && (includeTask || t.containsOnly)) {
        if (t.mode === "only") t.mode = "run";
      } else if (t.mode === "run" && !includeTask) t.mode = "skip";
      else if (t.mode === "only") t.mode = "run";
    }
    if (t.type === "suite") {
      if (t.mode === "skip") skipAll(t, "skip");
      else if (t.mode === "todo") skipAll(t, "todo");
      else interpretModes(t, onlyMode, includeTask);
    }
  }
  if (suite.mode === "run" && suite.tasks.length && suite.tasks.every((i) => i.mode !== "run")) {
    suite.mode = "skip";
  }
}

class SkipSignal extends Error {}

function withTimeout(promiseOrValue, ms, what) {
  if (!promiseOrValue || typeof promiseOrValue.then !== "function") return promiseOrValue;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out in ${ms}ms.`)), ms);
  });
  return Promise.race([promiseOrValue, timeout]).finally(() => clearTimeout(timer));
}

function chainOf(suite) {
  const chain = [];
  for (let s = suite; s; s = s.parent) chain.unshift(s);
  return chain;
}

function titlePath(task) {
  const titles = [];
  for (let s = task.parent; s && s.parent; s = s.parent) titles.unshift(s.name);
  return titles;
}

function serializeError(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 500);
  if (Array.isArray(e)) return e.map(serializeError).join(" | ");
  return String(e).slice(0, 500);
}

async function runTestOnce(test, context) {
  const errors = [];
  const teardowns = [];
  currentTest = { promises: [], onFinished: [], onFailed: [], result: { state: "run", errors: [] }, name: test.name };
  setState(freshState([...titlePath(test), test.name].join(" > ")), expect);
  let skipped = false;
  try {
    for (const s of chainOf(test.parent)) {
      for (const h of s.hooks.beforeEach) {
        const r = await withTimeout(h.fn(context, s), h.timeout, "Hook");
        if (typeof r === "function") teardowns.unshift(r);
      }
    }
    await withTimeout(test.fn(context), test.timeout, "Test");
    if (currentTest.promises.length) {
      const settled = await Promise.allSettled(currentTest.promises);
      for (const r of settled) if (r.status === "rejected") errors.push(r.reason);
    }
    const st = expect.getState();
    if (st.expectedAssertionsNumber !== null && st.assertionCalls !== st.expectedAssertionsNumber) {
      throw st.expectedAssertionsNumberErrorGen();
    }
    if (st.isExpectingAssertions === true && st.assertionCalls === 0) throw st.isExpectingAssertionsError;
  } catch (e) {
    if (e instanceof SkipSignal) skipped = true;
    else errors.push(e);
  }
  if (currentTest.result.errors.length) errors.push(...currentTest.result.errors);
  try {
    for (const s of chainOf(test.parent).toReversed()) {
      for (const h of s.hooks.afterEach.toReversed()) await withTimeout(h.fn(context, s), h.timeout, "Hook");
    }
    for (const t of teardowns) await t();
  } catch (e) {
    errors.push(e);
  }
  for (const fn of currentTest.onFinished) {
    try {
      await fn(context);
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length) {
    for (const fn of currentTest.onFailed) {
      try {
        await fn(context);
      } catch (e) {
        errors.push(e);
      }
    }
  }
  currentTest = null;
  return { skipped, errors };
}

async function runTest(test, file, out) {
  const name = [...titlePath(test), test.name].join(" > ");
  if (test.mode !== "run") {
    out.push({ file, name, status: "skip", mode: test.mode });
    return;
  }
  const context = {
    task: { name: test.name },
    expect,
    skip(note) {
      throw new SkipSignal(note ?? "skipped");
    },
    onTestFinished: (fn) => currentTest.onFinished.push(fn),
    onTestFailed: (fn) => currentTest.onFailed.push(fn),
    signal: new AbortController().signal,
  };
  let result;
  for (let repeat = 0; repeat <= test.repeats; repeat++) {
    for (let attempt = 0; attempt <= test.retry; attempt++) {
      result = await runTestOnce(test, context);
      if (result.skipped || result.errors.length === 0) break;
    }
    if (result.skipped || result.errors.length) break;
  }
  if (result.skipped) {
    out.push({ file, name, status: "skip", mode: "skip" });
    return;
  }
  let failed = result.errors.length > 0;
  let error = failed ? serializeError(result.errors.length === 1 ? result.errors[0] : result.errors) : undefined;
  if (test.fails) {
    error = failed ? undefined : "Expect test to fail";
    failed = !failed;
  }
  out.push(failed ? { file, name, status: "fail", error } : { file, name, status: "pass" });
}

function markAll(suite, file, out, status, error) {
  for (const t of suite.tasks) {
    if (t.type === "suite") markAll(t, file, out, status, error);
    else {
      const name = [...titlePath(t), t.name].join(" > ");
      out.push(error ? { file, name, status, error } : { file, name, status });
    }
  }
}

async function runSuite(suite, file, out) {
  if (suite.mode !== "run") {
    markAll(suite, file, out, "skip");
    return;
  }
  const teardowns = [];
  try {
    for (const h of suite.hooks.beforeAll) {
      const r = await withTimeout(h.fn(suite), h.timeout, "Hook");
      if (typeof r === "function") teardowns.unshift(r);
    }
  } catch (e) {
    markAll(suite, file, out, "fail", serializeError(e));
    return;
  }
  for (const t of suite.tasks) {
    if (t.type === "suite") await runSuite(t, file, out);
    else await runTest(t, file, out);
  }
  try {
    for (const h of suite.hooks.afterAll.toReversed()) await withTimeout(h.fn(suite), h.timeout, "Hook");
    for (const t of teardowns) await t();
  } catch (e) {
    out.push({ file, name: `${[...titlePath({ parent: suite }), suite.name].join(" > ")} [afterAll]`, status: "fail", error: serializeError(e) });
  }
}

const collected = new Map();
let breakTarget = null;

export const __keel = {
  breakMatcher(spec) {
    if (!spec || breakTarget) return;
    breakTarget = spec;
    // Deliberate sabotage for the "can the parity check fail?" demonstration.
    // "toBe:pass" makes the matcher always pass; "toBe:fail" makes it always throw.
    const [name, how = "pass"] = spec.split(":");
    chai.util.addMethod(chai.Assertion.prototype, name, function () {
      if (how === "fail") throw new chai.AssertionError(`${name} sabotaged for the parity demonstration`);
    });
  },
  async runFile(file, load) {
    let fileSuite = collected.get(file);
    if (!fileSuite) {
      fileSuite = newSuite("", "run", null, null);
      const prev = root;
      root = fileSuite;
      collectingSuite = fileSuite;
      try {
        await load();
        await collect(fileSuite);
      } finally {
        root = prev;
        collectingSuite = root;
      }
      fileSuite.containsOnly = fileSuite.tasks.some((t) => t.mode === "only" || (t.type === "suite" && t.containsOnly));
      interpretModes(fileSuite, fileSuite.containsOnly, false);
      collected.set(file, fileSuite);
    }
    const out = [];
    await runSuite(fileSuite, file, out);
    return out;
  },
};
