import { afterEach, describe, expect, it, vi } from "vitest";
import { answerUnhandled } from "../../src/adapters/driving/http/run.ts";
import { UndeclaredStatusError } from "../../src/generated/http/runtime.gen.ts";
import { describeDefect } from "../../src/rpc/index.ts";

/** What a held call is rejected with when the platform resets its object: the marks are the platform's. */
const reset = () =>
  Object.assign(
    new Error("Durable Object reset because its code was updated.", {
      cause: new TypeError("storage is gone", { cause: "the instance was replaced" }),
    }),
    { durableObjectReset: true, retryable: true, remote: false },
  );

/** What an object's own code threw, as the platform hands it on: a defect, not an object that could not take the call. */
const threw = () =>
  Object.assign(
    new Error("Cannot read properties of undefined (reading 'lease')", {
      cause: new TypeError("storage is gone", { cause: "the instance was replaced" }),
    }),
    { remote: true },
  );

/** Every line `console.error` was given, parsed: one a defect. */
const errorLines = () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () =>
    error.mock.calls.map((line): unknown => {
      expect(line).toHaveLength(1);
      return JSON.parse(String(line[0]));
    });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what a defect says of itself in a log line", () => {
  it("[rpc.defect-line] is its name, message, stack, causes and the platform's marks, each a string", () => {
    const line = describeDefect(reset());
    expect(line).toMatchObject({
      name: "Error",
      message: "Durable Object reset because its code was updated.",
      cause: "TypeError: storage is gone <- the instance was replaced",
      marks: ["durableObjectReset", "retryable"],
    });
    expect(line.stack).toContain("defect-line.test.ts");
    // What a log keeps: a nested Error would be `{}` here.
    expect(JSON.parse(JSON.stringify(line))).toEqual(line);
  });

  it("[rpc.defect-line] names a defect that is no Error by its type and its text", () => {
    expect(describeDefect("a bare string")).toEqual({
      name: "string",
      message: "a bare string",
      marks: [],
    });
    expect(describeDefect({ overloaded: true, code: 7 })).toEqual({
      name: "object",
      message: '{"overloaded":true,"code":7}',
      marks: ["overloaded"],
    });
    expect(describeDefect(undefined)).toEqual({
      name: "undefined",
      message: "undefined",
      marks: [],
    });
  });

  it("[rpc.defect-line] ends a cause that is its own cause", () => {
    const loop = new Error("round");
    loop.cause = loop;
    expect(describeDefect(loop).cause).toBe(
      "Error: round <- Error: round <- Error: round <- Error: round <- Error: round",
    );
  });
});

describe("the line something thrown past a handler leaves", () => {
  it("[http.unhandled-line] names what was thrown past a handler the same way, and answers 500", async () => {
    const lines = errorLines();
    const thrown = threw();
    const response = answerUnhandled(thrown, "req-thrown", true);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "internal.defect",
      requestId: "req-thrown",
    });
    expect(lines()).toEqual([
      {
        ops: "defect",
        requestId: "req-thrown",
        name: "Error",
        message: "Cannot read properties of undefined (reading 'lease')",
        stack: thrown.stack,
        cause: "TypeError: storage is gone <- the instance was replaced",
        marks: ["remote"],
      },
    ]);
  });

  it("[http.unhandled-line] logs a response that broke its contract apart, and throws it on only where asked", () => {
    const lines = errorLines();
    const drift = new UndeclaredStatusError("Agents_inbox", { status: 418 });
    expect(answerUnhandled(drift, "req-drift", false).status).toBe(500);
    expect(() => answerUnhandled(drift, "req-drift", true)).toThrow(drift);
    expect(lines()).toMatchObject([
      { ops: "contract-drift", requestId: "req-drift", name: "UndeclaredStatusError" },
      { ops: "contract-drift", requestId: "req-drift", name: "UndeclaredStatusError" },
    ]);
  });
});
