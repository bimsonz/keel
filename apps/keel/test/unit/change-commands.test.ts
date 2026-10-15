import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DeclareCommand, SubmitCommand } from "../../src/rpc/index.ts";

const declare = {
  changeId: "chg_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
  agentId: "agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
  projectId: "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
  goal: "Cache permission lookups per request",
  footprint: [{ path: "src/authz/**", op: "edit" }],
  premises: [],
  idempotencyKey: "declare-0001",
  fingerprint: "sha256:abc",
};

describe("the Change RPC commands", () => {
  it("decodes a declare without an origin as the agent's own", () => {
    const decoded = Schema.decodeUnknownSync(DeclareCommand)(declare);
    expect(decoded.origin).toBe("agent");
    expect(Schema.decodeUnknownSync(DeclareCommand)({ ...declare, origin: "auditor" }).origin).toBe(
      "auditor",
    );
  });

  it("refuses a declare with an empty goal, and a submit without a lease", () => {
    expect(() => Schema.decodeUnknownSync(DeclareCommand)({ ...declare, goal: "" })).toThrow(
      /\["goal"\]/,
    );
    expect(() =>
      Schema.decodeUnknownSync(SubmitCommand)({
        agentId: declare.agentId,
        projectId: declare.projectId,
        commitSha: "a".repeat(40),
        idempotencyKey: "submit-0001",
      }),
    ).toThrow(/leaseId/);
  });
});
