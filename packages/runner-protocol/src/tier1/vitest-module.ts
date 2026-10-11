/**
 * Keel's own `vitest` for Tier 1 probes: the virtual module a probe's
 * `import { describe, expect, it } from "vitest"` resolves to inside a
 * VerifierDO isolate. It replaces spike S14's shim over `@vitest/expect`,
 * `@vitest/spy`, `@vitest/utils` and chai, so bundling a probe never installs
 * a package.
 *
 * It offers describe, it/test and expect(x).toBe | toEqual | toMatch |
 * toThrow, read exactly as vitest 5.0.3 reads them: toBe is Object.is,
 * toEqual is vitest's `equals` with its iterable tester (both ported from
 * vitest, MIT), toMatch is `includes` or `String.prototype.match`, and toThrow
 * is chai's `throws` for a string, RegExp or nothing, vitest's own branches
 * otherwise. A differential test runs every matcher against real vitest.
 *
 * Anything else a probe reaches for (another matcher, `.not`, `it.skip`) is
 * recorded as unsupported, so the run is a harness error with deterministic
 * text, whatever the probe did with the thrown error. A missing export (`vi`,
 * `beforeEach`) fails at bundle time, which is a harness error too.
 *
 * `__keel.run(load)` imports the probe, runs its one test and reports the
 * probe exit-code contract that `readProbeRun` reads, as forge-lite's
 * `run-probe.mjs` does under real vitest:
 *
 *   0 pass    1 fail    3 n/a    2 harness error
 *
 * stdout is the probe's `[probe] ` observations (prefix dropped), then one
 * JSON line `{"outcome","reason"}`. n/a is the marked error
 * `Error("probe not applicable: <why>")`, so a probe runs the same here and
 * under real vitest. A pass with no observation is a harness error: a probe
 * that never reported what it saw proves nothing.
 *
 * The body is plain JS with no template literals, so it can sit in a
 * String.raw literal and be evaluated by the differential test as written.
 */
export const PROBE_VITEST_BODY = String.raw`
"use strict";
var tests = [];
var unsupported = [];
var path = [];

function KeelUnsupported(what) {
  var error = new Error("unsupported in Keel's probe vitest: " + what);
  error.name = "KeelUnsupported";
  unsupported.push(what);
  return error;
}

// A function's own plumbing, which bundled code may touch; anything else (it.skip, expect.any) is unsupported.
var PASS_THROUGH = ["prototype", "length", "name", "call", "apply", "bind", "toString"];

function guarded(name, fn) {
  return new Proxy(fn, {
    get: function (target, key) {
      if (typeof key === "symbol" || PASS_THROUGH.indexOf(key) !== -1) return target[key];
      throw KeelUnsupported(name + "." + String(key));
    },
  });
}

var describe = guarded("describe", function describe(name, body) {
  path.push(String(name));
  try { body(); } finally { path.pop(); }
});
var it = guarded("it", function it(name, body) {
  tests.push({ name: path.concat([String(name)]).join(" > "), body: body });
});

// ---- vitest 5.0.3's equals (expect-utils, MIT), the subset toEqual reaches ----

function isA(typeName, value) {
  return Object.prototype.toString.apply(value) === "[object " + typeName + "]";
}
function isAsymmetric(obj) {
  return !!obj && typeof obj === "object" && "asymmetricMatch" in obj && isA("Function", obj.asymmetricMatch);
}
function asymmetricMatch(a, b, testers) {
  var asymmetricA = isAsymmetric(a);
  var asymmetricB = isAsymmetric(b);
  if (asymmetricA && asymmetricB) return undefined;
  if (asymmetricA) return a.asymmetricMatch(b, testers);
  if (asymmetricB) return b.asymmetricMatch(a, testers);
  return undefined;
}
function isError(value) {
  if (typeof Error.isError === "function") return Error.isError(value);
  switch (Object.prototype.toString.call(value)) {
    case "[object Error]":
    case "[object Exception]":
    case "[object DOMException]":
      return true;
    default:
      return value instanceof Error;
  }
}
function isDomNode(obj) {
  return obj !== null && typeof obj === "object" && "nodeType" in obj && typeof obj.nodeType === "number" &&
    "nodeName" in obj && typeof obj.nodeName === "string" && "isEqualNode" in obj && typeof obj.isEqualNode === "function";
}
function hasKey(obj, key) {
  return Object.hasOwn(obj, key);
}
function hasDefinedKey(obj, key) {
  return hasKey(obj, key) && obj[key] !== undefined;
}
function keysOf(obj, has) {
  var out = [];
  for (var key in obj) if (has(obj, key)) out.push(key);
  return out.concat(Object.getOwnPropertySymbols(obj).filter(function (symbol) {
    return Object.getOwnPropertyDescriptor(obj, symbol).enumerable;
  }));
}
function equals(a, b, testers) {
  return eq(a, b, [], [], testers || [], hasDefinedKey);
}
function eq(a, b, aStack, bStack, testers, has) {
  var result = true;
  var asymmetric = asymmetricMatch(a, b, testers);
  if (asymmetric !== undefined) return asymmetric;
  for (var i = 0; i < testers.length; i++) {
    var tested = testers[i](a, b, testers);
    if (tested !== undefined) return tested;
  }
  if (typeof URL === "function" && a instanceof URL && b instanceof URL) return a.href === b.href;
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return a === b;
  var className = Object.prototype.toString.call(a);
  if (className !== Object.prototype.toString.call(b)) return false;
  switch (className) {
    case "[object Boolean]":
    case "[object String]":
    case "[object Number]":
      if (typeof a !== typeof b) return false;
      if (typeof a !== "object" && typeof b !== "object") return Object.is(a, b);
      return Object.is(a.valueOf(), b.valueOf());
    case "[object Date]": {
      var numA = +a;
      var numB = +b;
      return numA === numB || (Number.isNaN(numA) && Number.isNaN(numB));
    }
    case "[object RegExp]":
      return a.source === b.source && a.flags === b.flags;
    case "[object Temporal.Instant]":
    case "[object Temporal.ZonedDateTime]":
    case "[object Temporal.PlainDateTime]":
    case "[object Temporal.PlainDate]":
    case "[object Temporal.PlainTime]":
    case "[object Temporal.PlainYearMonth]":
    case "[object Temporal.PlainMonthDay]":
      return a.equals(b);
    case "[object Temporal.Duration]":
      return a.toString() === b.toString();
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (isDomNode(a) && isDomNode(b)) return a.isEqualNode(b);
  var length = aStack.length;
  while (length--) {
    if (aStack[length] === a) return bStack[length] === b;
    else if (bStack[length] === b) return false;
  }
  aStack.push(a);
  bStack.push(b);
  if (className === "[object Array]" && a.length !== b.length) return false;
  if (isError(a) && isError(b)) {
    try {
      return isErrorEqual(a, b, aStack, bStack, testers, has);
    } finally {
      aStack.pop();
      bStack.pop();
    }
  }
  var aKeys = keysOf(a, has);
  var size = aKeys.length;
  if (keysOf(b, has).length !== size) return false;
  while (size--) {
    var key = aKeys[size];
    result = has(b, key) && eq(a[key], b[key], aStack, bStack, testers, has);
    if (!result) return false;
  }
  aStack.pop();
  bStack.pop();
  return result;
}
function isErrorEqual(a, b, aStack, bStack, testers, has) {
  var result = Object.prototype.toString.call(a) === Object.prototype.toString.call(b) && a.name === b.name && a.message === b.message;
  if (typeof b.cause !== "undefined") result = result && eq(a.cause, b.cause, aStack, bStack, testers, has);
  if (a instanceof AggregateError && b instanceof AggregateError) result = result && eq(a.errors, b.errors, aStack, bStack, testers, has);
  result = result && eq(Object.assign({}, a), Object.assign({}, b), aStack, bStack, testers, has);
  return result;
}

var IS_KEYED = "@@__IMMUTABLE_KEYED__@@";
var IS_SET = "@@__IMMUTABLE_SET__@@";
var IS_LIST = "@@__IMMUTABLE_LIST__@@";
var IS_ORDERED = "@@__IMMUTABLE_ORDERED__@@";
var IS_RECORD = "@@__IMMUTABLE_RECORD__@@";
function isObjectLiteral(source) {
  return source != null && typeof source === "object" && !Array.isArray(source);
}
function immutableUnorderedKeyed(x) { return !!(x && x[IS_KEYED] && !x[IS_ORDERED]); }
function immutableUnorderedSet(x) { return !!(x && x[IS_SET] && !x[IS_ORDERED]); }
function immutableList(x) { return Boolean(x && isObjectLiteral(x) && x[IS_LIST]); }
function immutableOrderedKeyed(x) { return Boolean(x && isObjectLiteral(x) && x[IS_KEYED] && x[IS_ORDERED]); }
function immutableOrderedSet(x) { return Boolean(x && isObjectLiteral(x) && x[IS_SET] && x[IS_ORDERED]); }
function immutableRecord(x) { return Boolean(x && isObjectLiteral(x) && x[IS_RECORD]); }
function hasIterator(object) {
  return !!(object != null && object[Symbol.iterator]);
}
function iterableEquality(a, b, testers, aStack, bStack) {
  testers = testers || [];
  aStack = aStack || [];
  bStack = bStack || [];
  if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b) || !hasIterator(a) || !hasIterator(b)) return undefined;
  if (a.constructor !== b.constructor) return false;
  var length = aStack.length;
  while (length--) if (aStack[length] === a) return bStack[length] === b;
  aStack.push(a);
  bStack.push(b);
  var withStack = function (x, y) {
    return iterableEquality(x, y, testers.slice(), aStack.slice(), bStack.slice());
  };
  var filtered = testers.filter(function (t) { return t !== iterableEquality; }).concat([withStack]);
  if (a.size !== undefined) {
    if (a.size !== b.size) return false;
    if (isA("Set", a) || immutableUnorderedSet(a)) {
      var allFound = true;
      for (var aValue of a) {
        if (!b.has(aValue)) {
          var has = false;
          for (var bValue of b) if (equals(aValue, bValue, filtered) === true) has = true;
          if (has === false) { allFound = false; break; }
        }
      }
      aStack.pop();
      bStack.pop();
      return allFound;
    }
    if (isA("Map", a) || immutableUnorderedKeyed(a)) {
      var allEntries = true;
      for (var aEntry of a) {
        if (!b.has(aEntry[0]) || !equals(aEntry[1], b.get(aEntry[0]), filtered)) {
          var found = false;
          for (var bEntry of b) {
            var matchedKey = equals(aEntry[0], bEntry[0], filtered);
            var matchedValue = false;
            if (matchedKey === true) matchedValue = equals(aEntry[1], bEntry[1], filtered);
            if (matchedValue === true) found = true;
          }
          if (found === false) { allEntries = false; break; }
        }
      }
      aStack.pop();
      bStack.pop();
      return allEntries;
    }
  }
  var bIterator = b[Symbol.iterator]();
  for (var item of a) {
    var nextB = bIterator.next();
    if (nextB.done || !equals(item, nextB.value, filtered)) return false;
  }
  if (!bIterator.next().done) return false;
  if (!immutableList(a) && !immutableOrderedKeyed(a) && !immutableOrderedSet(a) && !immutableRecord(a)) {
    if (!equals(Object.entries(a), Object.entries(b), filtered)) return false;
  }
  aStack.pop();
  bStack.pop();
  return true;
}

// ---- the four matchers ----

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
  if (typeof value === "bigint") return String(value) + "n";
  if (typeof value === "symbol" || value === undefined || Number.isNaN(value)) return String(value);
  if (Object.is(value, -0)) return "-0";
  if (value instanceof RegExp || value instanceof Error) return String(value);
  try {
    var text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch (e) {
    return Object.prototype.toString.call(value);
  }
}
function AssertionError(message) {
  var error = new Error(message);
  error.name = "AssertionError";
  return error;
}
function assert(pass, message) {
  if (!pass) throw AssertionError(message);
}
function isRegExp(value) {
  return Object.prototype.toString.call(value) === "[object RegExp]";
}
var CHAI_FUNCTION_TYPES = ["function", "asyncfunction", "generatorfunction", "asyncgeneratorfunction"];
function chaiType(obj) {
  if (typeof obj === "undefined") return "undefined";
  if (obj === null) return "null";
  var tag = obj[Symbol.toStringTag];
  if (typeof tag === "string") return tag;
  return Object.prototype.toString.call(obj).slice(8, -1);
}
function chaiMessage(thrown, matcher) {
  var text = typeof thrown === "string" ? thrown : thrown.message;
  if (text === undefined) return false;
  if (isRegExp(matcher)) return matcher.test(text);
  if (typeof matcher === "string") return text.indexOf(matcher) !== -1;
  return false;
}

var matchers = {
  toBe: function (actual, expected) {
    assert(Object.is(actual, expected), "expected " + show(actual) + " to be " + show(expected) + " // Object.is equality");
  },
  toEqual: function (actual, expected) {
    assert(equals(actual, expected, [iterableEquality]), "expected " + show(actual) + " to deeply equal " + show(expected));
  },
  toMatch: function (actual, expected) {
    if (typeof actual !== "string") throw new TypeError(".toMatch() expects to receive a string, but got " + typeof actual);
    assert(typeof expected === "string" ? actual.includes(expected) : actual.match(expected), "expected " + show(actual) + " to match " + show(expected));
  },
  toThrow: function (actual, expected) {
    if (typeof expected === "string" || typeof expected === "undefined" || expected instanceof RegExp) {
      assert(CHAI_FUNCTION_TYPES.indexOf(chaiType(actual).toLowerCase()) !== -1, "expected " + show(actual) + " to be a function");
      var caught;
      var threw = false;
      try { actual(); } catch (err) { threw = true; caught = err; }
      assert(threw, "expected " + show(actual) + " to throw an error");
      if (caught && expected !== undefined && expected !== null) {
        assert(chaiMessage(caught, expected), "expected " + show(actual) + " to throw error matching " + show(expected) + " but got " + show(caught));
      }
      return;
    }
    var thrown = null;
    var isThrow = false;
    try { actual(); } catch (err) { isThrow = true; thrown = err; }
    assert(isThrow, "expected function to throw an error, but it didn't");
    if (typeof expected === "function") {
      var name = expected.name || expected.prototype.constructor.name;
      assert(thrown && thrown instanceof expected, "expected error to be instance of " + name);
      return;
    }
    if (isError(expected)) {
      assert(equals(thrown, expected, [iterableEquality]), "expected a thrown error to be " + show(expected));
      return;
    }
    if (typeof expected === "object" && "asymmetricMatch" in expected && typeof expected.asymmetricMatch === "function") {
      assert(thrown && expected.asymmetricMatch(thrown), "expected error to match asymmetric matcher");
      return;
    }
    assert(equals(thrown, expected, [iterableEquality]), "expected a thrown value to equal " + show(expected));
  },
};

var expect = guarded("expect", function expect(actual) {
  return new Proxy({}, {
    get: function (target, key) {
      if (typeof key === "string" && Object.hasOwn(matchers, key)) {
        return function (expected) { return matchers[key](actual, expected); };
      }
      if (key === "then") return undefined;
      throw KeelUnsupported("expect(...)." + String(key));
    },
  });
});

// ---- the probe run ----

var EXIT = { pass: 0, fail: 1, "n/a": 3 };
var HARNESS = 2;
var NOT_APPLICABLE = /^Error: probe not applicable: (.+)$/m;
var OBSERVATION = "[probe] ";
var MISMATCH = /-> (\d+)\b.*\(expected (\d+)\)$/;

function errorText(error) {
  if (error instanceof Error) return error.name + ": " + error.message;
  return String(error);
}
function report(observations, outcome, reason, exit) {
  var lines = observations.concat([JSON.stringify({ outcome: outcome, reason: reason })]);
  return { stdout: lines.join("\n") + "\n", exit: exit };
}
function harness(observations, reason) {
  return report(observations, "fail", "probe harness error: " + reason, HARNESS);
}

async function run(load) {
  var observations = [];
  var log = console.log;
  console.log = function () {
    var line = Array.prototype.map.call(arguments, String).join(" ");
    if (line.indexOf(OBSERVATION) === 0) observations.push(line.slice(OBSERVATION.length));
  };
  try {
    try {
      await load();
    } catch (error) {
      if (unsupported.length > 0) return harness(observations, "unsupported: " + unsupported[0]);
      return harness(observations, "the probe file failed to load: " + errorText(error).split("\n")[0]);
    }
    if (tests.length !== 1) {
      if (unsupported.length > 0) return harness(observations, "unsupported: " + unsupported[0]);
      return harness(observations, "expected exactly one probe test, found " + tests.length);
    }
    var failure;
    try {
      await tests[0].body();
    } catch (error) {
      failure = error === undefined ? new Error("the probe threw undefined") : error;
    }
    if (unsupported.length > 0) return harness(observations, "unsupported: " + unsupported[0]);
    if (failure === undefined) {
      if (observations.length === 0) return harness(observations, "the probe passed without reporting an observation");
      return report(observations, "pass", observations[observations.length - 1], EXIT.pass);
    }
    var text = errorText(failure);
    var notApplicable = NOT_APPLICABLE.exec(text);
    if (notApplicable) return report(observations, "n/a", notApplicable[1], EXIT["n/a"]);
    var mismatch = observations.find(function (line) {
      var statuses = MISMATCH.exec(line);
      return statuses !== null && statuses[1] !== statuses[2];
    });
    return report(observations, "fail", mismatch || text.split("\n")[0] || "the probe failed", EXIT.fail);
  } finally {
    console.log = log;
  }
}

return { describe: describe, it: it, test: it, expect: expect, __keel: { run: run } };
`;

/** The `vitest` virtual module itself: the body, evaluated once, re-exported. */
export const PROBE_VITEST_SOURCE = [
  `const api = (function () {${PROBE_VITEST_BODY}})();`,
  "export const describe = api.describe;",
  "export const it = api.it;",
  "export const test = api.test;",
  "export const expect = api.expect;",
  "export const __keel = api.__keel;",
].join("\n");
