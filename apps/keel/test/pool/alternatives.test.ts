// Same intent through real objects: each change is the harness's real Change
// DO reading its project's real Project DO index; the index tells each
// change's agent about its alternatives through the agent's real AgentSession
// DO. The doorways are REST and MCP, from the deployed fetch handler.
import { env, exports } from "cloudflare:workers";
import { LEASE_TTL_MS, Proposition } from "@keeltown/core/domain/coordination";
import { EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  drainOutbox,
  mcp,
  mcpResult,
  seedAgent,
  seedForeignAgent,
  tokenFor,
} from "./helpers.ts";

const claim = (subject: string) =>
  Schema.decodeUnknownSync(Proposition)({
    subject,
    predicate: "freshness",
    relation: "is",
    value: "per-session",
  });
/** What both attempts claim to make true: the same effects, named in either order. */
const effects = [claim("authz.permission-evaluation"), claim("billing.invoice-total")];

interface WireNotice {
  readonly id: string;
  readonly kind: string;
  readonly detail?: string;
  readonly ref?: string;
  readonly nextActions?: readonly { readonly operationId?: string; readonly args?: object }[];
}

const projectStub = (projectId: ProjectId) =>
  drainAfter(env.PROJECT.get(env.PROJECT.idFromName(`project:${projectId}`)));

/** A fresh project whose changes read its real index. */
async function project() {
  const projectId: ProjectId = makeId("prj", ulid());
  return { projectId, change: () => changeUnderTest(projectId, "project") };
}

/** A token for the agent that declared `c`. */
const tokenOf = async (c: ChangeUnderTest) =>
  tokenFor(await seedAgent({ id: c.agentId, projectId: c.projectId }));

/** Delivers what the changes owe the index, then what the index owes the agents. */
async function settle(projectId: ProjectId, ...changes: ChangeUnderTest[]) {
  for (const c of changes) await drainOutbox(c.stub);
  await drainOutbox(projectStub(projectId));
}

const inbox = async (token: string) => {
  const response = await exports.default.fetch(`${BASE}/v1/inbox`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json<{ result: { notices: WireNotice[] } }>()).result.notices;
};
const sameIntent = (notices: readonly WireNotice[]) =>
  notices.filter((n) => n.kind === "AlternativeDeclared" || n.kind === "AlternativeLanded");

const nearbyRest = async (c: ChangeUnderTest, token: string) => {
  const response = await exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/nearby`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return response.json<{ result: { preflight: { alternatives?: string[] } } }>();
};

/** A tool call's answer: its structured content, or a failure's problem from the text mirror. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const result = await mcpResult(await mcp(token, "tools/call", { name, arguments: args }, name));
  const [first] = Array.isArray(result["content"]) ? result["content"] : [];
  const text: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "text") : "";
  return result["structuredContent"] ?? (typeof text === "string" ? JSON.parse(text) : undefined);
}

/** A problem as any caller sees it: its request id dropped and the id it was asked for blanked. */
const blank = (body: object, id: string) => {
  const { requestId: _, ...rest } = Object(body);
  return JSON.parse(JSON.stringify(rest).replaceAll(id, "<id>"));
};

/** How to compare, rebase or withdraw, as the domain names them for `changeId` against `other`. */
const waysForward = (changeId: string, other: string) => [
  { kind: "read", operationId: "change", args: { changeId: other } },
  { kind: "read", operationId: "nearby", args: { changeId } },
  { kind: "call", operationId: "rebase", args: { changeId } },
  { kind: "call", operationId: "abandon", args: { changeId } },
];

describe("[b24.preflight-alternatives] two attempts at the same thing see each other", () => {
  it("[b24.preflight-alternatives] [b24.notice-next-actions] B's declare shows A; A is told by a notice with the ways forward; nearby shows each to the other over REST and MCP", async () => {
    const { projectId, change } = await project();
    const a = await change();
    ok(await a.declare("declare-a", { declaredEffects: effects }));
    await settle(projectId, a);
    const b = await change();
    const declared = ok(await b.declare("declare-b", { declaredEffects: effects.toReversed() }));
    await settle(projectId, b);

    expect(declared.preflight.alternatives).toEqual([a.changeId]);
    const [tokenA, tokenB] = [await tokenOf(a), await tokenOf(b)];
    const toldA = sameIntent(await inbox(tokenA));
    expect(toldA).toMatchObject([
      {
        kind: "AlternativeDeclared",
        ref: `project:${projectId}`,
        detail: `${b.changeId} was declared with the same intent as your change ${a.changeId}`,
        nextActions: waysForward(a.changeId, b.changeId),
      },
    ]);
    // B saw A in its own preflight, so B is not told again.
    expect(sameIntent(await inbox(tokenB))).toEqual([]);

    const nearA = await nearbyRest(a, tokenA);
    const nearB = await nearbyRest(b, tokenB);
    expect(nearA.result.preflight.alternatives).toEqual([b.changeId]);
    expect(nearB.result.preflight.alternatives).toEqual([a.changeId]);
    expect(await tool(tokenA, "nearby", { changeId: a.changeId })).toMatchObject({
      ok: true,
      result: { preflight: { alternatives: [b.changeId] } },
    });
  });
});

describe("[b24.change-tool] comparing over MCP: the change tool reads the other change", () => {
  it("[b24.change-tool] an agent of the project reads B as REST does; an agent of another org's project gets the 404 of an unknown change", async () => {
    const { projectId, change } = await project();
    const a = await change();
    ok(await a.declare("declare-a", { declaredEffects: effects }));
    await settle(projectId, a);
    const tokenA = await tokenOf(a);
    const viaTool = await tool(tokenA, "change", { changeId: a.changeId });
    const viaRest = await exports.default.fetch(`${BASE}/v1/changes/${a.changeId}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(viaTool).toEqual(await viaRest.json());
    expect(viaTool).toMatchObject({ id: a.changeId, state: "working" });

    const outsider = await tokenFor(await seedForeignAgent());
    const unknown = makeId("chg", ulid());
    const hidden = await tool(outsider, "change", { changeId: a.changeId });
    const missing = await tool(outsider, "change", { changeId: unknown });
    expect(hidden).toMatchObject({ status: 404, code: "change.not_found" });
    expect(blank(hidden, a.changeId)).toEqual(blank(missing, unknown));
  });
});

describe("[b24.adopted] the change's notices follow its adopter", () => {
  it("[b24.adopted] after an adopt, a new alternative is told to the adopter and not to the agent that let the lease lapse", async () => {
    const { projectId, change } = await project();
    const a = await change();
    ok(await a.declare("declare-a", { declaredEffects: effects }));
    await settle(projectId, a);
    const original = await tokenOf(a);
    const adopter = await tokenFor(await seedAgent({ projectId }));
    a.clock.advance(LEASE_TTL_MS);
    const adopted = await exports.default.fetch(`${BASE}/v1/changes/${a.changeId}/adopt`, {
      method: "POST",
      headers: { authorization: `Bearer ${adopter}`, "idempotency-key": "adopt-key-0001" },
    });
    expect(adopted.status).toBe(200);
    await settle(projectId, a);

    const b = await change();
    ok(await b.declare("declare-b", { declaredEffects: effects }));
    await settle(projectId, b);
    // A's log rides along, so a missing notice shows what the change went through.
    const seen = {
      adopter: sameIntent(await inbox(adopter)),
      original: sameIntent(await inbox(original)),
      log: (await a.log()).map((e) => e.type),
    };
    expect(seen).toMatchObject({
      adopter: [{ kind: "AlternativeDeclared", nextActions: waysForward(a.changeId, b.changeId) }],
      original: [],
    });
  });
});

describe("[b24.never-acts] a landing tells, and Keel does nothing else", () => {
  it("[b24.never-acts] A lands: B's agent is told with the ways forward, and B's log and state are as they were", async () => {
    const { projectId, change } = await project();
    const a = await change();
    ok(await a.declare("declare-a", { declaredEffects: effects }));
    await settle(projectId, a);
    const b = await change();
    expect(ok(await b.declare("declare-b", { declaredEffects: effects })).preflight).toMatchObject({
      alternatives: [a.changeId],
    });
    await settle(projectId, b);
    const before = await b.log();

    // A's landing, as its Change DO commits it, fed to the index as the fan-out feeds it.
    const last = (await a.log()).at(-1);
    if (last === undefined) throw new Error("A committed nothing");
    const landed: EventEnvelope = {
      ...last,
      eventId: makeId("evt", ulid()),
      type: "ChangeLanded",
      seq: last.seq + 1,
      dedupeKey: `landed-${a.changeId}`,
      payload: { _tag: "ChangeLanded", changeId: a.changeId },
    };
    await projectStub(projectId).receive([Schema.encodeSync(EventEnvelope)(landed)]);
    await settle(projectId, b);

    expect(sameIntent(await inbox(await tokenOf(b)))).toMatchObject([
      {
        kind: "AlternativeLanded",
        detail: `${a.changeId}, with the same intent as your change ${b.changeId}, landed`,
        nextActions: waysForward(b.changeId, a.changeId),
      },
    ]);
    expect(await b.log()).toEqual(before);
    expect((await b.current()).state).toBe("working");
  });
});
