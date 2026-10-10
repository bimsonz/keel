import { describe, test, expect, vi } from "vitest";
import { clamp, delayed, slugify } from "../src/math";

describe("slugify", () => {
  test.each`
    input              | expected
    ${"Hello World"}   | ${"hello-world"}
    ${"  trim me  "}   | ${"trim-me"}
    ${"a--b__c"}       | ${"a-b-c"}
  `("slugify($input) -> $expected", ({ input, expected }) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe("clamp", () => {
  test("clamps low", () => expect(clamp(-5, 0, 10)).toBe(0));
  test("clamps high", () => expect(clamp(50, 0, 10)).toBe(10));
  test("throws on inverted range", () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
    expect(() => clamp(1, 10, 0)).toThrowError(/lo > hi/);
  });
  test.skip("skipped on purpose", () => {
    expect(true).toBe(false);
  });
  test.todo("handles NaN");
});

describe("async + spies", () => {
  test("delayed resolves", async () => {
    await expect(delayed(42)).resolves.toBe(42);
  });
  test("spy records calls", () => {
    const fn = vi.fn((x: number) => x * 2);
    [1, 2, 3].forEach((n) => fn(n));
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith(3);
    expect(fn.mock.results.map((r) => r.value)).toEqual([2, 4, 6]);
  });
  test("asymmetric matchers", () => {
    expect({ id: 7, tags: ["a", "b"], at: "2026-10-10" }).toEqual({
      id: expect.any(Number),
      tags: expect.arrayContaining(["b"]),
      at: expect.stringMatching(/^\d{4}-/),
    });
  });
  test("expect.assertions counts", async () => {
    expect.assertions(2);
    expect(1).toBe(1);
    // Only one assertion ran: this test fails in vitest.
  });
});
