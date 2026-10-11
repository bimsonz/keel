import { describe, expect, it } from "vitest";
import { PROBE_VITEST_BODY } from "../../src/tier1/vitest-module.ts";
import { fc } from "../support/fast-check.ts";

type Matcher = "toBe" | "toEqual" | "toMatch" | "toThrow";

interface ProbeVitest {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => unknown) => void;
  readonly expect: (actual: unknown) => Record<Matcher, (expected?: unknown) => void>;
  readonly __keel: {
    readonly run: (load: () => unknown) => Promise<{ stdout: string; exit: number }>;
  };
}

/** A fresh copy of Keel's module, with no tests registered, as each isolate gets. */
const fresh = (): ProbeVitest =>
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion -- evaluates the module body exactly as the isolate's virtual module wraps it
  new Function(PROBE_VITEST_BODY)() as ProbeVitest;

const keel = fresh();

const passes = (assertion: () => void): boolean => {
  try {
    assertion();
    return true;
  } catch {
    return false;
  }
};

const vitestAsserts = (matcher: Matcher, actual: unknown, expected: unknown): void => {
  switch (matcher) {
    case "toBe":
      return expect(actual).toBe(expected);
    case "toEqual":
      return expect(actual).toEqual(expected);
    case "toMatch":
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vitest's own reading of a non-string, non-RegExp expectation is under test
      return expect(actual).toMatch(expected as string);
    case "toThrow":
      return expect(actual).toThrow(expected);
  }
};

/** Keel's verdict and real vitest's, for one matcher on one input. `expected` is a factory so a stateful RegExp is never shared. */
const verdicts = (matcher: Matcher, actual: unknown, expected: () => unknown) => ({
  keel: passes(() => keel.expect(actual)[matcher](expected())),
  vitest: passes(() => vitestAsserts(matcher, actual, expected())),
});

const value = fc.anything({
  maxDepth: 3,
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withNullPrototype: true,
  withObjectString: true,
  withSparseArray: true,
  withTypedArray: true,
});

class Custom extends Error {}
class Shape {
  constructor(readonly x: unknown) {}
}
class Other {
  constructor(readonly x: unknown) {}
}

const errorClass = fc.constantFrom(Error, TypeError, RangeError, Custom);
const errorValue = fc
  .tuple(
    errorClass,
    fc.constantFrom("", "boom", "probe not applicable: x", "Boom"),
    fc.option(value),
  )
  .map(([Kind, message, cause]) =>
    cause === null ? new Kind(message) : new Kind(message, { cause }),
  );

const regex = fc
  .tuple(
    fc.constantFrom(
      "a",
      "b",
      "^a",
      "a$",
      "a+",
      ".",
      "[ab]",
      "x?",
      "",
      "\\d",
      "(a|b)c",
      "boom",
      "^$",
    ),
    fc.subarray(["g", "i", "m", "s", "y"]),
  )
  .map(
    ([source, flags]) =>
      () =>
        new RegExp(source, flags.join("")),
  );

const text = fc.string({ unit: fc.constantFrom("a", "b", "c", "1", " ", "\n", "o", "m") });

/** Every case vitest's toEqual reads specially: ±0, NaN, undefined keys, holes, Map/Set order, classes, boxes, errors, cycles. */
const edgePairs = (): Array<[string, unknown, unknown]> => {
  const cycleA: Record<string, unknown> = { a: 1 };
  cycleA["self"] = cycleA;
  const cycleB: Record<string, unknown> = { a: 1 };
  cycleB["self"] = cycleB;
  const sparse: unknown[] = [];
  sparse[1] = 1;
  const nullProto = { a: 1 };
  Reflect.setPrototypeOf(nullProto, null);
  return [
    ["NaN", Number.NaN, Number.NaN],
    ["+0 and -0", 0, -0],
    ["-0 in an array", [0], [-0]],
    ["undefined key", { a: undefined, b: 1 }, { b: 1 }],
    ["undefined item", [undefined], []],
    ["hole and undefined", sparse, [undefined, 1]],
    [
      "Map order",
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
      new Map([
        ["b", 2],
        ["a", 1],
      ]),
    ],
    ["Map object keys", new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]])],
    ["Set order", new Set([1, 2]), new Set([2, 1])],
    ["Set of objects", new Set([{ a: 1 }]), new Set([{ a: 1 }])],
    ["Set vs array", new Set([1]), [1]],
    ["class vs literal", new Shape(1), { x: 1 }],
    ["class vs class", new Shape(1), new Other(1)],
    ["boxed vs primitive", Object(1), 1],
    ["boxed vs boxed", Object("a"), Object("a")],
    ["invalid dates", new Date(Number.NaN), new Date(Number.NaN)],
    ["dates", new Date(1), new Date(2)],
    ["regexps by flags", /a/g, /a/i],
    ["errors", new Error("a"), new Error("a")],
    ["error kinds", new TypeError("a"), new Error("a")],
    ["error causes", new Error("a", { cause: 1 }), new Error("a", { cause: 2 })],
    ["error vs object", new Error("a"), { message: "a" }],
    ["aggregate errors", new AggregateError([1], "a"), new AggregateError([2], "a")],
    ["cycles", cycleA, cycleB],
    ["cycle vs not", cycleA, { a: 1, self: { a: 1 } }],
    ["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
    ["typed array kinds", new Uint8Array([1]), new Int8Array([1])],
    ["array buffers", new Uint8Array([1]).buffer, new Uint8Array([2]).buffer],
    ["null prototype", nullProto, { a: 1 }],
    ["urls", new URL("https://a.example/x"), new URL("https://a.example/x")],
    ["null vs undefined", null, undefined],
    ["symbol keys", { [Symbol.for("k")]: 1 }, { [Symbol.for("k")]: 2 }],
    ["asymmetric", { asymmetricMatch: () => true }, 5],
    ["bigint", 1n, 1n],
    ["nested arrays", [[1, [2]]], [[1, [2]]]],
  ];
};

describe("Keel's probe vitest agrees with vitest 5.0.3", () => {
  it.each(edgePairs())("toEqual and toBe: %s", (_name, a, b) => {
    for (const matcher of ["toEqual", "toBe"] as const) {
      const both = verdicts(matcher, a, () => b);
      expect([matcher, both.keel]).toEqual([matcher, both.vitest]);
      const back = verdicts(matcher, b, () => a);
      expect([matcher, "reversed", back.keel]).toEqual([matcher, "reversed", back.vitest]);
    }
  });

  it("[probe-vitest.differential.toEqual] on any two values, and on equal clones", () => {
    const pair = fc.oneof(
      fc.tuple(value, value),
      fc.clone(value, 2),
      fc.clone(value, 2).map(([a, b]) => [a, [b]]),
    );
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const both = verdicts("toEqual", a, () => b);
        expect(both.keel).toBe(both.vitest);
      }),
    );
  });

  it("[probe-vitest.differential.toBe] on any two values and on one value twice", () => {
    fc.assert(
      fc.property(value, value, fc.boolean(), (a, b, same) => {
        const both = verdicts("toBe", a, () => (same ? a : b));
        expect(both.keel).toBe(both.vitest);
      }),
    );
  });

  it("[probe-vitest.differential.toMatch] on strings and non-strings, against strings, RegExps and anything", () => {
    const expected = fc.oneof(
      text.map((s) => () => s),
      regex,
      value.map((v) => () => v),
    );
    fc.assert(
      fc.property(fc.oneof(text, value), expected, (actual, make) => {
        const both = verdicts("toMatch", actual, make);
        expect(both.keel).toBe(both.vitest);
      }),
    );
  });

  it("[probe-vitest.differential.toThrow] on throwers, non-throwers and non-functions, against every kind of expectation", () => {
    const thrown = fc.oneof(errorValue, text, value);
    const actual = fc.oneof(
      thrown.map((t) => () => {
        throw t;
      }),
      // An async function never throws synchronously; one that resolves leaves no unhandled rejection.
      thrown.map((t) => async () => t),
      fc.constant(() => 1),
      fc.constant(
        class NotCallable {
          readonly x = 1;
        },
      ),
      value,
    );
    const expected = fc.oneof(
      fc.constant(() => undefined),
      text.map((s) => () => s),
      regex,
      errorClass.map((Kind) => () => Kind),
      errorValue.map((e) => () => e),
      value.map((v) => () => v),
    );
    fc.assert(
      fc.property(actual, expected, (fn, make) => {
        const both = verdicts("toThrow", fn, make);
        expect(both.keel).toBe(both.vitest);
      }),
    );
  });
});

describe("Keel's probe vitest refuses what it does not offer", () => {
  it.each([
    ["toContain", (v: ProbeVitest) => Reflect.get(v.expect([1]), "toContain")],
    [".not", (v: ProbeVitest) => Reflect.get(v.expect(1), "not")],
    ["it.skip", (v: ProbeVitest) => Reflect.get(v.it, "skip")],
    ["expect.any", (v: ProbeVitest) => Reflect.get(v.expect, "any")],
  ])("%s throws its own deterministic text", (_name, reach) => {
    expect(() => reach(fresh())).toThrow(/^unsupported in Keel's probe vitest: /);
  });
});

/** What a probe module does when it is imported: registers its tests through the module it was given. */
type Probe = (v: ProbeVitest) => void;

const runProbe = async (probe: Probe) => {
  const v = fresh();
  // oxlint-disable-next-line no-underscore-dangle -- the module's own entry, named so no probe import can clash with it
  const { stdout, exit } = await v.__keel.run(() => probe(v));
  const lines = stdout.replace(/\n$/, "").split("\n");
  return {
    exit,
    observations: lines.slice(0, -1),
    json: JSON.parse(lines.at(-1) ?? "") as unknown,
  };
};

const oneTest =
  (body: (v: ProbeVitest) => unknown): Probe =>
  (v) =>
    v.describe("probe", () => v.it("runs", () => body(v)));

describe("__keel.run reports the probe exit-code contract", () => {
  it("passes a probe that ran to its end and reported what it saw", async () => {
    const out = await runProbe(
      oneTest((v) => {
        console.log("[probe] bob DELETE /repos/alice/forge -> 403 (expected 403)");
        console.log("not an observation");
        v.expect(403).toBe(403);
      }),
    );
    expect(out).toEqual({
      exit: 0,
      observations: ["bob DELETE /repos/alice/forge -> 403 (expected 403)"],
      json: { outcome: "pass", reason: "bob DELETE /repos/alice/forge -> 403 (expected 403)" },
    });
  });

  it("[probe-vitest.pass-unobserved] makes a pass with no observation a harness error", async () => {
    const out = await runProbe(oneTest((v) => v.expect(1).toBe(1)));
    expect(out.exit).toBe(2);
    expect(out.json).toEqual({
      outcome: "fail",
      reason: "probe harness error: the probe passed without reporting an observation",
    });
  });

  it("fails citing the first step that answered differently", async () => {
    const out = await runProbe(
      oneTest(async (v) => {
        console.log("[probe] alice POST /x -> 201 (expected 201)");
        console.log("[probe] bob DELETE /repos/alice/forge -> 204 (expected 403)");
        v.expect(204).toBe(403);
      }),
    );
    expect(out.exit).toBe(1);
    expect(out.json).toEqual({
      outcome: "fail",
      reason: "bob DELETE /repos/alice/forge -> 204 (expected 403)",
    });
  });

  it("fails with the assertion's first line when no step mismatched", async () => {
    const out = await runProbe(oneTest((v) => v.expect(1).toBe(2)));
    expect(out).toMatchObject({
      exit: 1,
      json: { outcome: "fail", reason: "AssertionError: expected 1 to be 2 // Object.is equality" },
    });
  });

  it("is n/a only on the marked error", async () => {
    const out = await runProbe(
      oneTest(() => {
        throw new Error("probe not applicable: revoke route absent");
      }),
    );
    expect(out).toMatchObject({ exit: 3, json: { outcome: "n/a", reason: "revoke route absent" } });
    const typed = await runProbe(
      oneTest(() => {
        throw new TypeError("probe not applicable: revoke route absent");
      }),
    );
    expect(typed.exit).toBe(1);
  });

  it("[probe-vitest.one-test] makes zero tests or two a harness error", async () => {
    const none = await runProbe(() => undefined);
    expect(none).toMatchObject({
      exit: 2,
      json: { reason: "probe harness error: expected exactly one probe test, found 0" },
    });
    const two = await runProbe((v) => {
      v.it("a", () => console.log("[probe] a"));
      v.it("b", () => console.log("[probe] b"));
    });
    expect(two).toMatchObject({
      exit: 2,
      json: { reason: "probe harness error: expected exactly one probe test, found 2" },
    });
  });

  it("makes a probe that fails to load a harness error", async () => {
    const out = await runProbe(() => {
      throw new SyntaxError("Unexpected token");
    });
    expect(out).toMatchObject({
      exit: 2,
      json: {
        reason: "probe harness error: the probe file failed to load: SyntaxError: Unexpected token",
      },
    });
  });

  it("[probe-vitest.unsupported] makes an unsupported matcher a harness error even when the probe swallows it", async () => {
    const out = await runProbe(
      oneTest((v) => {
        console.log("[probe] saw it");
        try {
          Reflect.get(v.expect([1]), "toContain");
        } catch {
          // a probe that hides the refusal still cannot pass
        }
      }),
    );
    expect(out).toMatchObject({
      exit: 2,
      json: { reason: "probe harness error: unsupported: expect(...).toContain" },
    });
    const skipped = await runProbe((v) => Reflect.get(v.it, "skip"));
    expect(skipped).toMatchObject({
      exit: 2,
      json: { reason: "probe harness error: unsupported: it.skip" },
    });
  });

  it("puts console.log back after the run", async () => {
    const log = console.log;
    await runProbe(oneTest(() => undefined));
    expect(console.log).toBe(log);
  });
});
