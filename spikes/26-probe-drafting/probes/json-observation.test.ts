import { expect, it } from "vitest";

// Can-fail for the JSON-line check: an observation that is itself JSON. The
// runner prints observations before its outcome line, so stdout then holds two
// JSON lines, which the host must refuse (exit 2, "invalid JSON line").
it("logs JSON as an observation", () => {
  console.log(`[probe] ${JSON.stringify({ status: 403 })}`);
  expect(403).toBe(403);
});
