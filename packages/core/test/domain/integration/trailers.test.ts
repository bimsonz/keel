import { describe, expect, it } from "vitest";
import { changeIdOf } from "../../../src/domain/integration/index.ts";

const A = "chg_01M4XQVACBK7NN7HFN3RCD2WWK";
const B = "chg_01M4XQY2T2YHB9Y7CPNE5BY9YF";
/** A landed commit's message: subject, body, then its trailers. */
const landed = (...trailers: string[]) =>
  ["Rewrite price", "", "Make it double.", "", ...trailers].join("\n");

describe("a landed commit's trailers", () => {
  it("[trailer.change-id] names the change of the last Change-Id trailer, as git reads trailers, and none for a message without one or with one that is no change's id", () => {
    expect(changeIdOf(landed(`Change-Id: ${A}`, "Keel-Agent: agt_x", "Keel-Run: run_y"))).toBe(A);
    expect(changeIdOf(landed(`Change-Id: ${A}`, `Change-Id: ${B}`))).toBe(B);
    expect(changeIdOf(landed(`Change-Id: ${A}`, "Change-Id: I0123abcd"))).toBeUndefined();
    expect(changeIdOf("Start notes\n")).toBeUndefined();
    // Only a whole line is a trailer: a mention in the body is not.
    expect(changeIdOf(`Revert the change Change-Id: ${A} made\n`)).toBeUndefined();
  });
});
