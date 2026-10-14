// Relying, revising and reading what is near, through real objects: each
// change is the harness's real Change DO, reading its project's real Project
// DO index; the subjects it names are real Subject DOs, reached by the
// fan-out. The doorways are REST and MCP, from the deployed fetch handler.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { subjectAddress, subjectIdOf } from "@keeltown/core/application/coordination";
import { Proposition, SubjectKey } from "@keeltown/core/domain/coordination";
import { type EventEnvelope, makeId, type ProjectId } from "@keeltown/core/kernel";
import { EventOutbox } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok, refusal } from "./change-harness.ts";
import { BASE, drainAfter, drainOutbox, mcp, mcpResult, seedAgent, tokenFor } from "./helpers.ts";
import { inertProbe } from "./inert-probe.ts";

const key = (value: string) => Schema.decodeUnknownSync(SubjectKey)(value);
const LEAF = key("authz.permission-evaluation");
const ROOT = key("authz");

/** S1's pair: A relies on revocation taking effect per request; B's cache makes it per session. */
const freshPerRequest = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const cachedPerSession = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

const subjectStub = (projectId: ProjectId, subject: SubjectKey) =>
  drainAfter(env.SUBJECT.get(env.SUBJECT.idFromName(subjectAddress(projectId, subject))));

/** The subject's own events, as its Subject DO committed them. */
const subjectLog = (projectId: ProjectId, subject: SubjectKey) =>
  runInDurableObject(
    subjectStub(projectId, subject),
    (instance: SubjectDO): Promise<readonly EventEnvelope[]> =>
      instance["runtime"].runPromise(
        Effect.map(EventOutbox, (outbox) =>
          outbox.log({ kind: "subject", id: subjectIdOf(projectId, subject) }),
        ),
      ),
  );

const typesOf = (log: readonly EventEnvelope[]) => log.map((event) => event.type);
const changeOf = (event: EventEnvelope): unknown =>
  typeof event.payload === "object" && event.payload !== null
    ? Reflect.get(event.payload, "changeId")
    : undefined;

/** A fresh project, its changes reading its real index, and a token for another agent of it. */
async function project() {
  const projectId: ProjectId = makeId("prj", ulid());
  const token = await tokenFor(await seedAgent({ projectId }));
  return { projectId, token, change: () => changeUnderTest(projectId, "project") };
}

/** A tool call's answer: its structured content, or a failure's problem from the text mirror. */
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const result = await mcpResult(await mcp(token, "tools/call", { name, arguments: args }, name));
  const [first] = Array.isArray(result["content"]) ? result["content"] : [];
  const text: unknown =
    typeof first === "object" && first !== null ? Reflect.get(first, "text") : "";
  return result["structuredContent"] ?? (typeof text === "string" ? JSON.parse(text) : undefined);
}

const relyRest = (c: ChangeUnderTest, token: string, lease: string, idempotencyKey: string) =>
  exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/premises`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "keel-lease": lease,
      "idempotency-key": idempotencyKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ premise: Schema.encodeSync(Proposition)(freshPerRequest) }),
  });

const reviseRest = (
  c: ChangeUnderTest,
  token: string,
  lease: string,
  idempotencyKey: string,
  ifMatch: string,
  body: Record<string, unknown>,
) =>
  exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/revisions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "keel-lease": lease,
      "idempotency-key": idempotencyKey,
      "if-match": ifMatch,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const nearbyRest = (c: ChangeUnderTest, token: string) =>
  exports.default.fetch(`${BASE}/v1/changes/${c.changeId}/nearby`, {
    headers: { authorization: `Bearer ${token}` },
  });

describe("[b21.relying-subscribes] a declared premise reaches its subject and the subject's ancestors", () => {
  it("[b21.relying-subscribes] the premise's own Subject DO mints itself and relies the premise; its ancestor only mints; a second relier mints nothing", async () => {
    const { projectId, change } = await project();
    const a = await change();
    ok(await a.declare("declare-a", { premises: [freshPerRequest] }));
    await drainOutbox(a.stub);
    const b = await change();
    ok(await b.declare("declare-b", { premises: [freshPerRequest] }));
    await drainOutbox(b.stub);

    await vi.waitFor(
      async () => {
        expect(typesOf(await subjectLog(projectId, LEAF))).toEqual([
          "SubjectMinted",
          "PremiseRelied",
          "PremiseRelied",
        ]);
      },
      { timeout: 10_000, interval: 50 },
    );
    const leaf = await subjectLog(projectId, LEAF);
    expect(leaf.map(changeOf)).toEqual([undefined, a.changeId, b.changeId]);
    expect(leaf[0]?.payload).toMatchObject({
      subjectId: subjectIdOf(projectId, LEAF),
      key: LEAF,
      mintedBy: "agent",
    });
    expect(leaf.every((event) => event.project === projectId)).toBe(true);
    const root = await subjectLog(projectId, ROOT);
    expect(typesOf(root)).toEqual(["SubjectMinted"]);
    expect(root[0]?.payload).toMatchObject({ key: ROOT, gloss: "authz", anchors: [] });
  });
});

describe("[b21.rely] relying on a premise through the doorways", () => {
  it("[b21.rely] REST adds the premise at the next revision with its preflight, MCP's retry with the key answers the same, and the subject relies it", async () => {
    await using probes = await inertProbe();
    const { projectId, token, change } = await project();
    const b = await change();
    ok(await b.declare("declare-b", { declaredEffects: [cachedPerSession] }));
    await drainOutbox(b.stub);
    const a = await change();
    const declared = ok(await a.declare("declare-a"));
    const lease = declared.change.lease.id;

    const response = await relyRest(a, token, lease, "rely-key-0001");
    const body = await response.json<{
      ok: boolean;
      result: {
        change: { id: string; revision: number; premises: unknown[] };
        preflight: { contradictions: { holder: string }[]; suggestedMove: string };
      };
    }>();
    const replayed = await tool(token, "rely", {
      changeId: a.changeId,
      "keel-lease": lease,
      "idempotency-key": "rely-key-0001",
      premise: Schema.encodeSync(Proposition)(freshPerRequest),
    });

    expect(response.status).toBe(200);
    expect(body.result.change).toMatchObject({ id: a.changeId, revision: 2 });
    expect(body.result.change.premises).toHaveLength(1);
    expect(body.result.preflight.contradictions.map((found) => found.holder)).toEqual([a.changeId]);
    // A's new premise meets B's effect: what A relies on is about to change, so A sequences.
    expect(body.result.preflight.suggestedMove).toBe("sequence");
    expect(replayed).toMatchObject({ ok: true, result: { change: { revision: 2 } } });
    expect((await a.current()).intent.revision).toBe(2);

    await drainOutbox(a.stub);
    await vi.waitFor(
      async () => {
        const relied = (await subjectLog(projectId, LEAF)).filter(
          (event) => event.type === "PremiseRelied",
        );
        expect(relied.map(changeOf)).toEqual([a.changeId]);
      },
      { timeout: 10_000, interval: 50 },
    );
    // A's premise against B's effect opens a conflict here: the fan-out starts its Probe, held inert.
    await vi.waitFor(async () => expect(await probes.get()).toHaveLength(1), {
      timeout: 10_000,
      interval: 50,
    });
  });

  it("[b21.rely] refuses another lease as 409 change.lease_stale, and relies nothing", async () => {
    const { token, change } = await project();
    const a = await change();
    ok(await a.declare("declare-a"));
    const response = await relyRest(a, token, makeId("lse", ulid()), "rely-key-0002");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "change.lease_stale" });
    expect((await a.current()).intent.revision).toBe(1);
  });
});

describe("[b21.nearby] what is near a change, read-only", () => {
  it("[b21.nearby] answers the contradiction with the neighbour's effect, commits nothing, and refuses an agent of another project", async () => {
    const { token, change } = await project();
    const b = await change();
    ok(await b.declare("declare-b", { declaredEffects: [cachedPerSession] }));
    await drainOutbox(b.stub);
    const a = await change();
    ok(await a.declare("declare-a", { premises: [freshPerRequest] }));
    await drainOutbox(a.stub);
    const before = (await a.log()).length;

    const response = await nearbyRest(a, token);
    const viaTool = await tool(token, "nearby", { changeId: a.changeId });
    const foreign = await nearbyRest(a, await tokenFor(await seedAgent()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: {
        preflight: {
          neighbours: [{ changeId: b.changeId }],
          contradictions: [{ holder: a.changeId, withRole: "effect" }],
          suggestedMove: "sequence",
          basis: { _tag: "contradiction", index: 0 },
        },
      },
    });
    expect(viaTool).toMatchObject({
      ok: true,
      result: { preflight: { suggestedMove: "sequence" } },
    });
    expect(foreign.status).toBe(403);
    // The doorway's policy refuses the foreign agent first; the change's own object refuses another project too.
    const elsewhere = decodeExit(
      ChangeCodecs.nearby,
      await a.stub.nearby({ projectId: makeId("prj", ulid()) }),
    );
    expect(refusal(elsewhere)).toContain('"_tag":"ChangeInOtherProject"');
    expect((await a.log()).length).toBe(before);
  });

  it("[b21.nearby] [b21.preflight-view] B's nearby names A, whose premise B's effect breaks, and suggests refine citing it, over REST and MCP", async () => {
    const { token, change } = await project();
    const a = await change();
    ok(await a.declare("declare-a", { premises: [freshPerRequest] }));
    await drainOutbox(a.stub);
    const b = await change();
    ok(await b.declare("declare-b", { declaredEffects: [cachedPerSession] }));
    await drainOutbox(b.stub);

    const response = await nearbyRest(b, token);
    const viaTool = await tool(token, "nearby", { changeId: b.changeId });

    const preflight = {
      neighbours: [{ changeId: a.changeId, overlap: "subject" }],
      contradictions: [
        {
          premise: Schema.encodeSync(Proposition)(freshPerRequest),
          with: Schema.encodeSync(Proposition)(cachedPerSession),
          holder: a.changeId,
          withRole: "effect",
        },
      ],
      precedents: [],
      suggestedMove: "refine",
      basis: { _tag: "contradiction", index: 0 },
    };
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { preflight } });
    expect(viaTool).toMatchObject({ ok: true, result: { preflight } });
  });
});

describe("[b21.revise-route] revising at the revision last read", () => {
  it('[b21.revise-route] If-Match "1" revises; a stale revision is 412 naming the current one; a weak tag is 400; MCP\'s bare revision revises', async () => {
    const { token, change } = await project();
    const a = await change();
    const lease = ok(await a.declare("declare-a")).change.lease.id;
    const effects = { declaredEffects: [Schema.encodeSync(Proposition)(cachedPerSession)] };

    const revised = await reviseRest(a, token, lease, "revise-key-0001", '"1"', effects);
    const stale = await reviseRest(a, token, lease, "revise-key-0002", '"1"', effects);
    const weak = await reviseRest(a, token, lease, "revise-key-0003", 'W/"2"', effects);
    const viaTool = await tool(token, "revise", {
      changeId: a.changeId,
      "keel-lease": lease,
      "idempotency-key": "revise-key-0004",
      "if-match": "2",
      goal: "Cache permission lookups per session",
    });

    expect(revised.status).toBe(200);
    expect(await revised.json()).toMatchObject({ result: { change: { revision: 2 } } });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({
      code: "change.revision_mismatch",
      nextActions: [
        { operationId: "status" },
        { operationId: "revise", args: { changeId: a.changeId, "if-match": '"2"' } },
      ],
    });
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({
      code: "request.invalid",
      issues: [{ path: ["if-match"] }],
    });
    expect(viaTool).toMatchObject({
      ok: true,
      result: { change: { revision: 3, goal: "Cache permission lookups per session" } },
    });
    expect((await a.current()).intent).toMatchObject({
      revision: 3,
      declaredEffects: [cachedPerSession],
    });
  });
});
