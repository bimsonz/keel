import { describe, expect, it } from "vitest";
import type { NextAction } from "../../../src/contract/events.ts";
import { citedIn } from "../../../src/engine/decisions.ts";

const read = (decisionId: unknown): NextAction => ({
  kind: "read",
  title: "Read the decision this guard holds",
  operationId: "Memory_getDecision",
  args: { decisionId },
});

describe("the decision a bounce cites", () => {
  it("[decisions.cited] is the one its next actions say to read, wherever that action stands among them", () => {
    expect(
      citedIn([
        { kind: "call", title: "Revise the change", operationId: "Changes_revise" },
        read("dec_01"),
        read("dec_02"),
      ]),
    ).toBe("dec_01");
    expect(citedIn([read("dec_07")])).toBe("dec_07");
  });

  it("[decisions.cited-by-argument] is taken from the action's own argument, never from a sentence or from another operation", () => {
    // A title that names a decision says to read nothing.
    expect(citedIn([{ kind: "read", title: "Read decision dec_01 (D-1) before revising" }])).toBe(
      undefined,
    );
    // Another operation that happens to carry a decision's id is not a citation.
    expect(
      citedIn([
        {
          kind: "call",
          title: "Distinguish this change from the decision",
          operationId: "Coordination_resolve",
          args: { decisionId: "dec_01" },
        },
      ]),
    ).toBe(undefined);
    // An action that names no decision, or names one that is no id, cites none.
    expect(citedIn([{ kind: "read", title: "Read it", operationId: "Memory_getDecision" }])).toBe(
      undefined,
    );
    expect(citedIn([read(""), read(7), read(undefined)])).toBe(undefined);
    expect(citedIn([])).toBe(undefined);
  });
});
