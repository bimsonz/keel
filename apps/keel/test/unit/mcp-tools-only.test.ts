// The MCP door names only tools as next actions: an agent connected over MCP
// can call nothing else, and a next action it cannot take leaves it stuck.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import {
  onlyTools,
  PERSON_INSTRUCTIONS,
  toolsOnly,
} from "../../src/adapters/driving/mcp/server.ts";
import { TOOL_NAMES } from "../../src/generated/mcp/mcp.gen.ts";

/**
 * Every operation a next action names that is no MCP tool, and why. A next
 * action is written for the agent that reads it: add an operation here only
 * when nobody on MCP is ever told of it, or tag it `mcp`.
 */
const NOT_TOOLS: Readonly<Record<string, string>> = {
  Auth_exchangeToken: "a credential exchange: an enrolled agent's, over REST",
  Auth_registerClient: "the front door's sign-up, before any token",
  Delivery_beginCloudflareConnect: "a person's",
  Delivery_listCredentials: "a person's",
  Delivery_listDeployTargets: "a person's",
  Delivery_putDeployTarget: "a person's",
  ManageOwners: "a person's",
  Namespaces_inviteAgent: "a person's",
  Namespaces_listAgents: "a person's",
  Operator_createProject: "a person's, or an agent's over REST",
  Operator_enrolAgent: "a person's",
  Operator_putSettings: "a person's, or an agent's over REST",
  Operator_reinstateAgent: "a sponsor's",
  Projects_listAgents: "a person's",
  Sessions_openSession: "the refusal of a session opened over REST",
  SetHandle: "a person's",
  Users_listSponsorRequests: "a person's",
  Users_me: "a person's",
};

const ROOTS = ["src", "../../packages/core/src"].map((root) =>
  join(import.meta.dirname, "../..", root),
);

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });

/** A notice that names next actions, as the inbox gives one. */
const notice = (actions: unknown[]) => ({ kind: "AgentInvited", nextActions: actions });

describe("what an MCP agent is told to do next", () => {
  it("[mcp.tools-only] an answer at the MCP door names only tools: in its next, a refusal's next actions and each notice's, its inbox page's too; an escalate and a wait are kept", () => {
    const tool = { kind: "call", title: "a tool", operationId: "whoami" };
    const other = { kind: "call", title: "no tool", operationId: "Auth_exchangeToken" };
    const ask = { kind: "escalate", title: "ask a person" };
    expect(
      toolsOnly({
        ok: true,
        next: [tool, other, ask],
        notices: [notice([other, tool])],
        result: { notices: [notice([other]), { kind: "ChangeLanded" }], cursor: "000000000001" },
      }),
    ).toEqual({
      ok: true,
      next: [tool, ask],
      notices: [notice([tool])],
      result: { notices: [notice([]), { kind: "ChangeLanded" }], cursor: "000000000001" },
    });
    expect(toolsOnly({ status: 403, nextActions: [other, ask] })).toEqual({
      status: 403,
      nextActions: [ask],
    });
    expect(toolsOnly("text")).toBe("text");
  });

  it("[mcp.tools-only] the door's own handlers answer through it: a tool's next actions lose what is no tool", async () => {
    const said = {
      next: [
        { kind: "call", title: "Read your own record", operationId: "Users_me" },
        { kind: "call", title: "Read who you are", operationId: "whoami" },
      ],
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one handler stands for the door's whole table
    const handlers = { whoami: async () => ({ status: 200, body: said }) } as unknown as Parameters<
      typeof onlyTools
    >[0];
    const door: unknown = onlyTools(handlers);
    const whoami: unknown = Reflect.get(Object(door), "whoami");
    if (typeof whoami !== "function") throw new Error("whoami is not wrapped");
    const caller: Partial<Caller> = { requestId: "req-tools-only" };
    expect(await Reflect.apply(whoami, undefined, [caller, {}])).toEqual({
      status: 200,
      body: { next: [{ kind: "call", title: "Read who you are", operationId: "whoami" }] },
    });
  });

  it("[mcp.next-are-tools] every operation Keel's code names as a next action is a tool, or one nobody on MCP is told of, named with why", () => {
    const tools = new Set<string>(TOOL_NAMES);
    const named = new Map<string, string>();
    for (const root of ROOTS)
      for (const file of sources(root))
        for (const [, op] of readFileSync(file, "utf8").matchAll(/operationId: *"([A-Za-z_]+)"/g))
          if (op !== undefined && !named.has(op)) named.set(op, relative(root, file));
    const unexplained = [...named]
      .filter(([op]) => !tools.has(op) && !(op in NOT_TOOLS))
      .map(([op, file]) => `${op} (${file})`);
    expect(unexplained).toEqual([]);
    // The list holds no operation that has since become a tool or left the code.
    expect(Object.keys(NOT_TOOLS).filter((op) => tools.has(op) || !named.has(op))).toEqual([]);
    expect(named.size).toBeGreaterThan(30);
  });
});

describe("proposals over MCP", () => {
  it("[mcp.proposal-tools] every proposal operation is a tool, and a person's assistant is told to read a proposal before approving it, naming the commit, on their word alone", () => {
    const tools = new Set<string>(TOOL_NAMES);
    expect(
      [
        "propose",
        "proposals",
        "updateProposal",
        "approveProposal",
        "requestProposalChanges",
        "closeProposal",
      ].filter((op) => !tools.has(op)),
    ).toEqual([]);
    for (const named of ["`proposals`", "`approveProposal`", "`change`", "`diff`"])
      expect(PERSON_INSTRUCTIONS).toContain(named);
    expect(PERSON_INSTRUCTIONS).toMatch(/commit/);
  });
});
