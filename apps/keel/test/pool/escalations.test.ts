// A conflict put to a person, on the real path. Two real Change DOs declare,
// the Subject DO's fallout opens the conflict and the ledger proves it; a
// party escalates it through the deployed fetch handler; the real namespace
// object raises the escalation and takes the ruling; the real Projector
// serves the question and the decision; and each party's Change DO parks and
// resumes through the real fan-out. The ruling is given through the
// `Escalations` port's own adapter, not through its doorway operation.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  conflictIdOf,
  conflictView,
  decisionIdOf,
  EFFECT_STANDS,
  escalationIdOf,
  namespaceAddress,
} from "@keeltown/core/application/coordination";
import { MAINTAINERS_AFTER_MS } from "@keeltown/core/application/memory";
import { Proposition } from "@keeltown/core/domain/coordination";
import {
  type AgentId,
  type ConflictId,
  Instant,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { Escalations, EventOutbox, ProbeLedger, PROJECTOR } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { EscalationsRpc } from "../../src/adapters/driven/do-rpc/escalations.ts";
import { ProbeLedgerRpc } from "../../src/adapters/driven/do-rpc/probe-ledger.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { AgentSessionCodecs, ChangeCodecs, decodeExit } from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  drainOutbox,
  OTHER_ORG,
  POOL_ORG,
  POOL_SPONSOR,
  seedAgent,
  seedUser,
  tokenFor,
  uniqueHandle,
  worker,
} from "./helpers.ts";
import { inertPrecheck } from "./inert-precheck.ts";
import { inertProbe } from "./inert-probe.ts";
import { admitted, LEAF, subjectOf } from "./probe-harness.ts";

const WAIT = { timeout: 20_000, interval: 50 };
const PLAN_HASH = `sha256:${"e".repeat(64)}`;

const relied = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "at-most",
  value: "per-request",
});
const cached = Schema.decodeUnknownSync(Proposition)({
  subject: LEAF,
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});

const namespaceObject = (address: string) =>
  drainAfter(env.NAMESPACE.get(env.NAMESPACE.idFromName(address)));

/** The questions put to people, read and ruled on as the doorway's handlers will: the Projector's view, the namespace's object. */
const escalations = <A, E>(use: (port: (typeof Escalations)["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.exit(
      Escalations.use(use).pipe(
        Effect.provide(
          EscalationsRpc(
            () => env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR)),
            namespaceObject,
          ),
        ),
      ),
    ),
  );

/** Declares with `intent`, pushes, submits and starts Precheck: the change is deriving, awaiting its plan. */
async function deriving(c: ChangeUnderTest, intent: Parameters<ChangeUnderTest["declare"]>[1]) {
  const lease = ok(await c.declare(`declare-${c.changeId}`, intent)).change.lease.id;
  await drainOutbox(c.stub);
  const commitSha = await c.push();
  ok(
    decodeExit(
      ChangeCodecs.submit,
      await c.stub.submit({ agentId: c.agentId, leaseId: lease, commitSha, idempotencyKey: "s-1" }),
    ),
  );
  ok(
    decodeExit(
      ChangeCodecs.precheckStarted,
      await c.stub.precheckStarted({ revision: 1, instanceId: "p-1" }),
    ),
  );
  return lease;
}

/** Precheck's plan for the change: it is queued on its project's lane. */
const compile = async (c: ChangeUnderTest) =>
  ok(
    decodeExit(
      ChangeCodecs.planCompiled,
      await c.stub.planCompiled({
        revision: 1,
        instanceId: "p-1",
        planHash: PLAN_HASH,
        steps: 1,
        costEstimate: 1,
      }),
    ),
  );

const typesOf = async (c: ChangeUnderTest) => (await c.log()).map((event) => event.type);

/** Every notice in the agent's inbox, read from the start. */
async function inboxOf(agentId: AgentId) {
  const agent = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(`agent:${agentId}`));
  return ok(decodeExit(AgentSessionCodecs.inbox, await agent.inbox({ waitMs: 0 }))).notices;
}

/** The conflict's own events on its Subject DO. */
const conflictLog = (projectId: ProjectId, conflictId: ConflictId) =>
  runInDurableObject(subjectOf(projectId), (instance: SubjectDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) => outbox.log({ kind: "conflict", id: conflictId })),
    ),
  );

interface Envelope {
  readonly ok: boolean;
  readonly summary: string;
  readonly result: { readonly conflict: { readonly id: string; readonly state: string } };
  readonly next: readonly { readonly operationId?: string }[];
}
interface Detail {
  readonly state: string;
  readonly move?: string;
  readonly escalation?: {
    readonly id: string;
    readonly label?: string;
    readonly open: boolean;
    readonly reason?: string;
    readonly question?: string;
    readonly state?: string;
    readonly options?: readonly { readonly id: string }[];
    readonly evidence?: readonly { readonly class: string }[];
  };
  readonly decision?: {
    readonly id: string;
    readonly label?: string;
    readonly chosen?: { readonly id: string; readonly label: string };
  };
}

/** A party's move through the doorway, under its change's lease. */
const resolve = (
  token: string,
  conflictId: string,
  lease: string,
  key: string,
  body: { readonly move: string; readonly changeId: string; readonly note?: string },
) =>
  worker(`${BASE}/v1/conflicts/${conflictId}/resolution`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
      "keel-lease": lease,
    },
    body: JSON.stringify(body),
  });

const get = (path: string, token: string) =>
  worker(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });

interface Question {
  readonly id: string;
  readonly label: string;
  readonly project: { readonly id: string; readonly namespace: string; readonly name: string };
  readonly state: string;
}

/** A reader's escalations through the doorway: an agent's project's, or a person's inbox. */
async function questions(token: string, query = "") {
  const response = await get(`/v1/escalations${query}`, token);
  const body = await response.json<{ readonly items?: readonly Question[] }>();
  return { status: response.status, items: body.items ?? [] };
}

/** A person's ruling through the doorway. */
const rule = (token: string, escalationId: string, key: string, option: string) =>
  worker(`${BASE}/v1/escalations/${escalationId}/ruling`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ option, rationale: "the session cache is the product" }),
  });

describe("[t35.park-resume] a conflict put to a person parks its parties until the ruling", () => {
  it("[t35.park-resume] [t67.inbox] a party escalates a proven conflict over REST: its sponsor is asked and reads it in their inbox, the queued party parks and the deriving one parks the moment it is queued; the ruling records D-1, resolves the conflict and resumes both, each told", async () => {
    await using probes = await inertProbe();
    await using prechecks = await inertPrecheck();
    const projectId = makeId("prj", ulid());
    const [a, b] = [
      await changeUnderTest(projectId, "project"),
      await changeUnderTest(projectId, "project"),
    ];
    const sponsor = await seedUser(uniqueHandle("asked"), { role: "member" });
    const maintainer = await seedUser(uniqueHandle("keeper"), { role: "maintainer" });
    const agentA = await seedAgent({ id: a.agentId, projectId, sponsor: sponsor.userId });
    await seedAgent({ id: b.agentId, projectId });
    const token = await tokenFor(agentA);

    // Fallout opens the conflict as both declare; the ledger proves it.
    const lease = await deriving(a, { premises: [relied] });
    await deriving(b, { declaredEffects: [cached] });
    await vi.waitFor(async () => expect(await prechecks.get()).toHaveLength(2), WAIT);
    const conflictId = conflictIdOf(projectId, {
      premise: { holder: a.changeId, proposition: relied },
      effect: { changeId: b.changeId, proposition: cached },
    });
    await vi.waitFor(async () => expect(await probes.get()).toHaveLength(1), WAIT);
    expect((await compile(a)).state).toBe("queued");
    await admitted(projectId, conflictId);
    await drainOutbox(subjectOf(projectId));
    const escalationId = escalationIdOf(conflictId);
    const decisionId = decisionIdOf(escalationId);

    // The doorway refuses a lease that is not the change's, and answers the unbuilt moves as declared.
    const stale = await resolve(token, conflictId, makeId("lse", ulid()), "resolve-0", {
      move: "escalate",
      changeId: a.changeId,
    });
    expect([stale.status, (await stale.json<{ code: string }>()).code]).toEqual([
      409,
      "change.lease_stale",
    ]);
    const unbuilt = await resolve(token, conflictId, lease, "resolve-0", {
      move: "yield",
      changeId: a.changeId,
    });
    expect(unbuilt.status).toBe(503);

    // A's agent escalates.
    const escalate = { move: "escalate", changeId: a.changeId, note: "the two cannot both ship" };
    const moved = await vi.waitFor(async () => {
      const response = await resolve(token, conflictId, lease, "resolve-1", escalate);
      expect(response.status).toBe(200);
      return response.json<Envelope>();
    }, WAIT);
    const again = await resolve(token, conflictId, lease, "resolve-1", escalate);
    expect(moved).toMatchObject({
      ok: true,
      result: { conflict: { id: conflictId, state: "escalated" } },
    });
    expect(moved.next.map((action) => action.operationId)).toContain("Conflicts_getConflict");
    expect(await again.json<Envelope>()).toMatchObject({
      result: { conflict: { state: "escalated" } },
    });

    // The queued party parks where it waits; the deriving one goes on, and parks in the commit that queues it.
    await vi.waitFor(async () => expect((await a.current()).state).toBe("parked"), WAIT);
    expect(await a.current()).toMatchObject({
      parkReason: "awaiting-ruling",
      parkedFrom: "queued",
      escalationId,
    });
    await vi.waitFor(async () => expect(await typesOf(b)).toContain("ConflictNoted"), WAIT);
    expect((await b.current()).state).toBe("deriving");
    expect(await compile(b)).toMatchObject({ state: "parked", parkedFrom: "queued", escalationId });
    expect((await typesOf(b)).slice(-3)).toEqual(["PlanCompiled", "ChangeQueued", "ChangeParked"]);

    // One escalation, in the project's namespace, asking the escalating agent's sponsor first.
    await drainOutbox(namespaceObject(namespaceAddress(POOL_ORG)));
    const asked = ok(await escalations((port) => port.get(escalationId)));
    expect(asked).toMatchObject({
      namespace: POOL_ORG,
      project: projectId,
      sponsor: sponsor.userId,
      escalation: { state: "open", about: { kind: "conflict", id: conflictId } },
    });
    const raisedAt = asked.escalation.raisedAt;
    const listedTo = async (userId: typeof sponsor.userId, maintains: boolean, after: number) =>
      ok(
        await escalations((port) =>
          port.list({
            reader: { _tag: "User", userId, maintains: maintains ? [POOL_ORG] : [] },
            now: Instant(raisedAt + after),
          }),
        ),
      )
        .items.map((item) => item.escalation.id)
        .includes(escalationId);
    expect([
      await listedTo(sponsor.userId, false, 0),
      await listedTo(maintainer.userId, true, 0),
      await listedTo(maintainer.userId, true, MAINTAINERS_AFTER_MS),
      await listedTo(POOL_SPONSOR, false, MAINTAINERS_AFTER_MS),
    ]).toEqual([true, false, true, false]);

    // A member reads the question on the conflict's own page.
    const open = await vi.waitFor(async () => {
      const response = await get(`/v1/conflicts/${conflictId}?project=${projectId}`, sponsor.token);
      expect(response.status).toBe(200);
      const body = await response.json<Detail>();
      expect(body.escalation?.question).toBeDefined();
      return body;
    }, WAIT);
    expect(open).toMatchObject({
      state: "escalated",
      escalation: {
        id: escalationId,
        label: "E-1",
        open: true,
        reason: "human-class",
        state: "open",
      },
    });
    expect(open.escalation?.options?.map((option) => option.id)).toContain(EFFECT_STANDS);
    expect(open.escalation?.evidence?.map((evidence) => evidence.class)).toContain("proof");

    // [t67.inbox] The inbox through the doorway. The person asked reads the question with Keel's label
    // and its project's place, and so does the project's agent; a maintainer's turn has not come, and
    // a person of another namespace reads nothing of it.
    const outsider = await seedUser(uniqueHandle("outside"), { org: OTHER_ORG });
    const row = {
      id: escalationId,
      label: "E-1",
      project: { id: projectId, namespace: "pool", name: projectId.toLowerCase() },
      state: "open",
    };
    expect(await questions(sponsor.token)).toEqual({
      status: 200,
      items: [expect.objectContaining(row)],
    });
    expect(await questions(token)).toEqual({ status: 200, items: [expect.objectContaining(row)] });
    expect(await questions(maintainer.token)).toEqual({ status: 200, items: [] });
    expect(await questions(outsider.token)).toEqual({ status: 200, items: [] });

    // From outside the namespace the question is not there to rule on; inside it, only who is asked or maintains may.
    const fromOutside = await rule(outsider.token, escalationId, "ruling-0", EFFECT_STANDS);
    expect([fromOutside.status, (await fromOutside.json<{ code: string }>()).code]).toEqual([
      404,
      "escalation.not_found",
    ]);
    const notOffered = await rule(sponsor.token, escalationId, "ruling-0", "neither");
    expect([notOffered.status, (await notOffered.json<{ code: string }>()).code]).toEqual([
      400,
      "escalation.option_unknown",
    ]);

    // The person asked rules: the decision is recorded with the ruling, and the subject resolves its conflict with it.
    const ruling = await rule(sponsor.token, escalationId, "ruling-1", EFFECT_STANDS);
    expect(ruling.status).toBe(200);
    expect(await ruling.json<Question>()).toMatchObject({ ...row, state: "ruled" });
    const repeated = await rule(sponsor.token, escalationId, "ruling-1", EFFECT_STANDS);
    expect([repeated.status, (await repeated.json<Question>()).state]).toEqual([200, "ruled"]);
    const second = await rule(maintainer.token, escalationId, "ruling-2", EFFECT_STANDS);
    expect([second.status, (await second.json<{ code: string }>()).code]).toEqual([
      409,
      "escalation.state_refused",
    ]);
    await vi.waitFor(async () => {
      expect((await questions(sponsor.token, "?state=ruled")).items).toEqual([
        expect.objectContaining({ ...row, state: "ruled" }),
      ]);
      expect((await questions(sponsor.token, "?state=open")).items).toEqual([]);
    }, WAIT);
    await vi.waitFor(async () => {
      const view = await runInDurableObject(subjectOf(projectId), (instance: SubjectDO) =>
        instance["runtime"].runPromise(conflictView(conflictId)),
      );
      expect(view.conflict).toMatchObject({ state: "resolved", move: "escalate", decisionId });
    }, WAIT);
    const moves = (await conflictLog(projectId, conflictId)).filter(
      (event) => event.type === "ConflictEscalated" || event.type === "ConflictResolved",
    );
    expect(moves.map((event) => [event.type, event.actor])).toEqual([
      ["ConflictEscalated", `agent:${a.agentId}`],
      ["ConflictResolved", undefined],
    ]);

    // Both parties resume into the queue, under the decision.
    for (const party of [a, b]) {
      await vi.waitFor(async () => expect(await typesOf(party)).toContain("ChangeResumed"), WAIT);
      const log = await party.log();
      const parked = log.findIndex((event) => event.type === "ChangeParked");
      expect(log[parked + 1]).toMatchObject({ type: "ChangeResumed", payload: { decisionId } });
      expect((await party.current()).state).not.toBe("parked");
    }

    // Each is told: the party that did not escalate hears the escalation too; nobody hears its own move.
    await vi.waitFor(async () => {
      const [toA, toB] = [await inboxOf(a.agentId), await inboxOf(b.agentId)];
      const types = (notices: typeof toA) => notices.map((notice) => notice.kind);
      expect(types(toB)).toEqual(
        expect.arrayContaining([
          "ConflictEscalated",
          "ChangeParked",
          "ConflictResolved",
          "ChangeResumed",
        ]),
      );
      expect(types(toA)).toEqual(
        expect.arrayContaining(["ChangeParked", "ConflictResolved", "ChangeResumed"]),
      );
      expect(types(toA)).not.toContain("ConflictEscalated");
      expect(toB.find((notice) => notice.kind === "ConflictResolved")).toMatchObject({
        detail: `decided by ${decisionId}`,
      });
    }, WAIT);

    // The conflict's page says what was decided.
    const settled = await vi.waitFor(async () => {
      const response = await get(`/v1/conflicts/${conflictId}?project=${projectId}`, sponsor.token);
      const body = await response.json<Detail>();
      expect(body.state).toBe("resolved");
      expect(body.decision?.chosen).toBeDefined();
      return body;
    }, WAIT);
    expect(settled).toMatchObject({
      move: "escalate",
      escalation: { open: false, state: "ruled" },
      decision: { id: decisionId, label: "D-1", chosen: { id: EFFECT_STANDS } },
    });
  });

  it("[t35.unprovable-escalates] a conflict whose probe could not be drafted is put to a person by Keel, asking the sponsor of the premise holder's agent", async () => {
    await using probes = await inertProbe();
    const projectId = makeId("prj", ulid());
    const [a, b] = [
      await changeUnderTest(projectId, "project"),
      await changeUnderTest(projectId, "project"),
    ];
    const sponsor = await seedUser(uniqueHandle("holder"), { role: "member" });
    await seedAgent({ id: a.agentId, projectId, sponsor: sponsor.userId });
    await seedAgent({ id: b.agentId, projectId });
    ok(await a.declare(`declare-${a.changeId}`, { premises: [relied] }));
    await drainOutbox(a.stub);
    ok(await b.declare(`declare-${b.changeId}`, { declaredEffects: [cached] }));
    await drainOutbox(b.stub);
    const conflictId = conflictIdOf(projectId, {
      premise: { holder: a.changeId, proposition: relied },
      effect: { changeId: b.changeId, proposition: cached },
    });
    await vi.waitFor(async () => expect(await probes.get()).toHaveLength(1), WAIT);
    const escalationId = escalationIdOf(conflictId);

    // The Probe Workflow reports that its drafting failed, through the ledger's own adapter.
    const failed = ok(
      await Effect.runPromise(
        Effect.exit(
          ProbeLedger.use((ledger) =>
            ledger.probeDraftFailed(
              { projectId, key: LEAF },
              { conflictId, attempts: 3, reason: "abstained" },
            ),
          ).pipe(
            Effect.provide(
              ProbeLedgerRpc((address) => env.SUBJECT.get(env.SUBJECT.idFromName(address))),
            ),
          ),
        ),
      ),
    );
    expect(failed.conflict).toMatchObject({ state: "escalated", escalationId });
    await drainOutbox(subjectOf(projectId));
    await drainOutbox(namespaceObject(namespaceAddress(POOL_ORG)));

    const escalated = (await conflictLog(projectId, conflictId)).filter(
      (event) => event.type === "ConflictEscalated",
    );
    expect(escalated.map((event) => [event.payload, event.actor])).toEqual([
      [expect.objectContaining({ escalationId, reason: "unprovable" }), undefined],
    ]);
    expect(ok(await escalations((port) => port.get(escalationId)))).toMatchObject({
      namespace: POOL_ORG,
      project: projectId,
      sponsor: sponsor.userId,
      escalation: { state: "open", category: "unprovable-conflict" },
    });
  });
});
