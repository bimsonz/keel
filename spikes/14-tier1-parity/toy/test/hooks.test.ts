import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { makeStore, storesCreated } from "../src/store";

const log: string[] = [];

describe("hook order", () => {
  beforeAll(() => {
    log.push("beforeAll");
  });
  afterAll(() => {
    log.push("afterAll");
  });
  beforeEach(() => {
    log.push("beforeEach");
    return () => log.push("teardown");
  });
  afterEach(() => {
    log.push("afterEach");
  });
  it("first", () => {
    expect(log).toEqual(["beforeAll", "beforeEach"]);
  });
  it("second", () => {
    expect(log).toEqual(["beforeAll", "beforeEach", "afterEach", "teardown", "beforeEach"]);
  });
});

describe("module state", () => {
  it("sees a fresh module graph per file", () => {
    makeStore();
    // Holds only if this file's modules are not shared with other test files.
    expect(storesCreated()).toBe(1);
  });
});
