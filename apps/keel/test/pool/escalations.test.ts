// A conflict put to a person, on the real path. Two real Change DOs declare,
// the Subject DO's fallout opens the conflict and the ledger proves it; a
// party escalates it through the deployed fetch handler; the real namespace
// object raises the escalation and takes the ruling; the real Projector
// serves the question and the decision; and each party's Change DO parks and
// resumes through the real fan-out. The ruling is given through the
// `Escalations` port's own adapter, not through its doorway operation.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  conflictIdOf,
  conflictView,
  decisionIdOf,
  EFFECT_STANDS,
  escalationIdOf,
  namespaceAddress,
  PREMISE_HOLDS,
  questionsToRecheck,
  SUBJECT_HELD,
} from "@keeltown/core/application/coordination";
import { MAINTAINERS_AFTER_MS } from "@keeltown/core/application/memory";
import { Proposition } from "@keeltown/core/domain/coordination";
import {
  type AgentId,
  type ConflictId,
  type EscalationId,
  Instant,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import {
  EntityStore,
  Escalations,
  EventOutbox,
  ProbeLedger,
  PROJECTOR,
} from "@keeltown/core/ports";
import { makeManualClock } from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { describe, expect, it, vi } from "vitest";
import { EscalationsRpc } from "../../src/adapters/driven/do-rpc/escalations.ts";
import { ProbeLedgerRpc } from "../../src/adapters/driven/do-rpc/probe-ledger.ts";
import { armedAlarms, scheduleAlarm } from "../../src/adapters/driving/do/alarm.ts";
import type { NamespaceDO } from "../../src/adapters/driving/do/namespace.ts";
import type { SubjectDO } from "../../src/adapters/driving/do/subject.ts";
import { backbone } from "../../src/composition/do.ts";
import {
  AgentSessionCodecs,
  ChangeCodecs,
  decodeExit,
  NamespaceCodecs,
  RaiseCommand,
} from "../../src/rpc/index.ts";
import { type ChangeUnderTest, changeUnderTest, ok, refusal } from "./change-harness.ts";
import {
  BASE,
  drainAfter,
  drainOutbox,
  establishProject,
  OTHER_ORG,
  placeProject,
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
import { project } from "./project-harness.ts";

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
  readonly next: readonly { readonly operationId?: string; readonly args?: unknown }[];
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
    readonly options?: readonly { readonly id: string; readonly consequence?: string }[];
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
  it("[t35.park-resume] [t67.inbox] [b31.distinguish] [b31.precedent-preflight] a party escalates a proven conflict over REST: its sponsor is asked and reads it in their inbox, the queued party parks and the deriving one parks the moment it is queued; the ruling records D-1 and resolves the conflict against the premise's holder, which bounces by the decision with what the option said of it while the other resumes, each told; the party ruled against distinguishes D-1 on its change and nothing else moves, and a change declared later on the premise D-1 went against is shown D-1 once and told to distinguish", async () => {
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
    const leaseB = await deriving(b, { declaredEffects: [cached] });
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
    // What preflight suggests is no move; a distinction needs its words; a conflict nobody ruled on set no precedent.
    for (const move of ["proceed", "refine", "yield", "merge"]) {
      const suggested = await resolve(token, conflictId, lease, `resolve-${move}`, {
        move,
        changeId: a.changeId,
      });
      expect([move, suggested.status]).toEqual([move, 400]);
    }
    const wordless = await resolve(token, conflictId, lease, "resolve-wordless", {
      move: "distinguish",
      changeId: a.changeId,
    });
    expect(wordless.status).toBe(400);
    expect(await wordless.json()).toMatchObject({
      issues: [expect.objectContaining({ path: ["body", "note"] })],
    });
    const unruled = await resolve(token, conflictId, lease, "resolve-unruled", {
      move: "distinguish",
      changeId: a.changeId,
      note: "this change reads the cache through another path",
    });
    expect([unruled.status, (await unruled.json<{ code: string }>()).code]).toEqual([
      409,
      "conflict.move_refused",
    ]);

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
    const effectStands = open.escalation?.options?.find((option) => option.id === EFFECT_STANDS);
    expect(effectStands?.consequence).toContain(a.changeId);
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
      // The effect stands, so the ruling goes against the change that relied on the premise.
      expect(view.conflict).toMatchObject({
        state: "resolved",
        move: "escalate",
        decisionId,
        against: [a.changeId],
      });
    }, WAIT);
    const moves = (await conflictLog(projectId, conflictId)).filter(
      (event) => event.type === "ConflictEscalated" || event.type === "ConflictResolved",
    );
    expect(moves.map((event) => [event.type, event.actor])).toEqual([
      ["ConflictEscalated", `agent:${a.agentId}`],
      ["ConflictResolved", undefined],
    ]);

    // The party ruled against goes back to its agent by the decision, with the chosen option's own
    // consequence as the reason and revising or withdrawing as its ways on. It never resumes.
    await vi.waitFor(async () => expect(await typesOf(a)).toContain("ChangeBounced"), WAIT);
    const logA = await a.log();
    expect(logA[logA.findIndex((event) => event.type === "ChangeParked") + 1]).toMatchObject({
      type: "ChangeBounced",
      payload: {
        decisionId,
        reasons: [effectStands?.consequence],
        nextActions: [
          expect.objectContaining({ operationId: "revise" }),
          expect.objectContaining({ operationId: "abandon" }),
        ],
      },
    });
    expect(await typesOf(a)).not.toContain("ChangeResumed");
    expect((await a.current()).state).toBe("bounced");

    // The party the ruling favours resumes into the queue, under the decision.
    await vi.waitFor(async () => expect(await typesOf(b)).toContain("ChangeResumed"), WAIT);
    const logB = await b.log();
    expect(logB[logB.findIndex((event) => event.type === "ChangeParked") + 1]).toMatchObject({
      type: "ChangeResumed",
      payload: { decisionId },
    });
    expect(await typesOf(b)).not.toContain("ChangeBounced");
    expect((await b.current()).state).not.toBe("parked");

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
        expect.arrayContaining(["ChangeParked", "ConflictResolved", "ChangeBounced"]),
      );
      expect(types(toA)).not.toContain("ConflictEscalated");
      expect(toA.find((notice) => notice.kind === "ChangeBounced")).toMatchObject({
        detail: `ruled against by ${decisionId}`,
      });
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

    // The party ruled against answers the precedent D-1 set: the distinction is recorded on its
    // change, and no conflict, verdict or state moves. A retry answers the same and records nothing.
    const distinction = {
      move: "distinguish",
      changeId: a.changeId,
      note: "this change reads the cache through another path",
    };
    const distinguished = await resolve(token, conflictId, lease, "resolve-2", distinction);
    expect(distinguished.status).toBe(200);
    expect(await distinguished.json<Envelope>()).toMatchObject({
      ok: true,
      result: { conflict: { id: conflictId, state: "resolved" } },
      next: [{ operationId: "Memory_getDecision", args: { decisionId } }],
    });
    expect((await resolve(token, conflictId, lease, "resolve-2", distinction)).status).toBe(200);
    const reworded = await resolve(token, conflictId, lease, "resolve-2", {
      ...distinction,
      note: "another reason",
    });
    expect(reworded.status).toBe(409);
    // The change's own object fences the lease, whatever the doorway read before it.
    const fenced = decodeExit(
      ChangeCodecs.distinguish,
      await a.stub.distinguish({
        agentId: a.agentId,
        leaseId: makeId("lse", ulid()),
        decisionId,
        distinction: distinction.note,
        idempotencyKey: "distinguish-fenced",
      }),
    );
    expect(refusal(fenced)).toContain('"_tag":"LeaseStale"');
    const stances = (await a.log()).filter((event) => event.type.startsWith("Precedent"));
    expect(stances.map((event) => event.payload)).toEqual([
      {
        _tag: "PrecedentDistinguished",
        decisionId,
        changeId: a.changeId,
        distinction: distinction.note,
      },
    ]);
    expect((await a.current()).state).toBe("bounced");
    const after = await get(`/v1/conflicts/${conflictId}?project=${projectId}`, sponsor.token);
    expect(await after.json<Detail>()).toMatchObject({ state: "resolved", move: "escalate" });

    // With the favoured party withdrawn, a change declared later relying on the premise D-1 went
    // against is shown D-1 and told to distinguish it, and D-1 is surfaced on it once, however often
    // its preflight shows it again.
    ok(
      decodeExit(
        ChangeCodecs.abandon,
        await b.stub.abandon({
          authority: { _tag: "Lease", leaseId: leaseB, agentId: b.agentId },
          idempotencyKey: "withdraw-b",
        }),
      ),
    );
    await drainOutbox(b.stub);
    const c = await changeUnderTest(projectId, "project");
    const declared = ok(await c.declare("declare-c", { premises: [relied] }));
    expect(declared.preflight).toMatchObject({
      precedents: [{ decisionId }],
      suggestedMove: "distinguish",
      basis: { _tag: "precedent", decisionId },
    });
    const shown = async () =>
      (await c.log()).filter((event) => event.type === "PrecedentSurfaced").map((e) => e.payload);
    expect(await shown()).toEqual([
      { _tag: "PrecedentSurfaced", decisionId, changeId: c.changeId },
    ]);
    const elsewhere = Schema.decodeUnknownSync(Proposition)({
      subject: `${LEAF}.elsewhere`,
      predicate: "freshness",
      relation: "is",
      value: "per-request",
    });
    const relying = ok(
      decodeExit(
        ChangeCodecs.rely,
        await c.stub.rely({
          agentId: c.agentId,
          leaseId: declared.change.lease.id,
          premise: elsewhere,
          idempotencyKey: "rely-c",
        }),
      ),
    );
    expect(relying.preflight.precedents).toEqual([expect.objectContaining({ decisionId })]);
    expect(await shown()).toEqual([
      { _tag: "PrecedentSurfaced", decisionId, changeId: c.changeId },
    ]);
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

  it("[esc-withdraw.real] once both changes of a conflict put to a person have withdrawn, the namespace's object hears it through the fan-out and withdraws the question, and the Projector's view says so", async () => {
    await using probes = await inertProbe();
    const { a, b, stateOf, withdraw } = await escalatedPair(probes);
    expect(await stateOf()).toBe("open");

    await withdraw(a);
    expect(await stateOf()).toBe("open");
    await withdraw(b);
    await vi.waitFor(async () => expect(await stateOf()).toBe("withdrawn"), WAIT);
  });

  it("[esc-recheck.orphan] a question left open by a subject that never withdrew it, with both its changes gone, is withdrawn on the namespace object's next run", async () => {
    await using probes = await inertProbe();
    const { projectId, a, b, escalationId, stateOf } = await escalatedPair(probes);
    await leftUnowed(projectId, [a.changeId, b.changeId]);
    expect(await stateOf()).toBe("open");

    await nextRun();
    await vi.waitFor(async () => expect(await stateOf()).toBe("withdrawn"), WAIT);
    expect(await toRecheck(escalationId)).toBe(false);
  });

  it("[esc-recheck.live] a question one of whose changes is still held stays open when its raiser is asked again; [esc-recheck.once] and its raiser is never asked again", async () => {
    await using probes = await inertProbe();
    const { projectId, a, b, escalationId, stateOf } = await escalatedPair(probes);
    await leftUnowed(projectId, [a.changeId]);

    await nextRun();
    await vi.waitFor(async () => expect(await toRecheck(escalationId)).toBe(false), WAIT);
    expect(await stateOf()).toBe("open");

    // Its last change leaves unseen, as before subjects withdrew their own: the asked question is not asked again.
    await leftUnowed(projectId, [b.changeId]);
    await nextRun();
    expect(await stateOf()).toBe("open");
  });
});

/**
 * Two real changes whose conflict's probe could not decide it, so the subject
 * put it to a person on the pool org's namespace object: the question is open.
 */
async function escalatedPair(probes: Awaited<ReturnType<typeof inertProbe>>) {
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
  ok(
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
  await drainOutbox(subjectOf(projectId));
  const ns = namespaceObject(namespaceAddress(POOL_ORG));
  await drainOutbox(ns);
  const stateOf = async () =>
    ok(await escalations((port) => port.get(escalationId))).escalation.state;
  /** The change withdraws, and its end reaches the subject and the namespace's object. */
  const withdraw = async (c: ChangeUnderTest) => {
    ok(
      decodeExit(
        ChangeCodecs.abandon,
        await c.stub.abandon({
          authority: { _tag: "Lease", leaseId: (await c.current()).lease.id, agentId: c.agentId },
          idempotencyKey: `abandon-${c.changeId}`,
        }),
      ),
    );
    await drainOutbox(c.stub);
    await drainOutbox(ns);
  };
  return { projectId, a, b, escalationId, stateOf, withdraw };
}

/**
 * The subject as one was left before subjects withdrew their own questions:
 * these changes are gone from it, and it owes nothing.
 */
const leftUnowed = (projectId: ProjectId, changeIds: readonly string[]) =>
  runInDurableObject(subjectOf(projectId), (instance: SubjectDO) =>
    instance["runtime"].runPromise(
      Effect.map(EntityStore, (store) => {
        for (const changeId of changeIds) store.remove(SUBJECT_HELD, changeId);
      }),
    ),
  );

/** The pool org's namespace object starts again, as after a deploy, and runs whatever it armed. */
async function nextRun() {
  const stub = env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(POOL_ORG)));
  await evictDurableObject(stub);
  await runDurableObjectAlarm(stub);
  await drainOutbox(namespaceObject(namespaceAddress(POOL_ORG)));
}

/** Whether the pool org's namespace object still has to ask this question's raiser about it again. */
const toRecheck = (escalationId: EscalationId) =>
  runInDurableObject(
    env.NAMESPACE.get(env.NAMESPACE.idFromName(namespaceAddress(POOL_ORG))),
    (instance: NamespaceDO) =>
      instance["runtime"].runPromise(
        Effect.map(questionsToRecheck, (owed) =>
          owed.some((question) => question.escalationId === escalationId),
        ),
      ),
  );

type NamespaceStub = ReturnType<typeof namespaceObject>;

const widening = (escalationId: string) => `escalation ${escalationId} widens`;

/** The deadline an escalation owes: thirty minutes after it was raised. */
const owed = (escalation: { readonly id: string; readonly raisedAt: number }) => ({
  kind: "deadline",
  reason: widening(escalation.id),
  at: escalation.raisedAt + MAINTAINERS_AFTER_MS,
});

/** The widening deadlines armed in `storage` for these escalations, by reason. */
const wideningsIn = (storage: DurableObjectStorage, escalationIds: readonly string[]) =>
  armedAlarms(storage)
    .filter((alarm) => escalationIds.some((id) => alarm.reason === widening(id)))
    .toSorted((a, b) => a.reason.localeCompare(b.reason));

/** The widening deadlines the namespace's object has armed for these escalations. */
const wideningsOf = (stub: NamespaceStub, escalationIds: readonly string[]) =>
  runInDurableObject(stub, (_instance: NamespaceDO, state) =>
    wideningsIn(state.storage, escalationIds),
  );

/**
 * An escalation raised on the real namespace object as if `ago` milliseconds
 * ago: the object's clock reads that moment for the raise alone, and its own
 * runtime is back before the turn ends, so everything after is the object as
 * deployed. Nothing is stamped ahead of the real clock, so what the raise
 * commits is due for delivery at once. Answers the escalation with the
 * deadline armed for it, read in the same turn: one already due fires by
 * itself as soon as the turn is over.
 */
const raisedAgo = (
  stub: NamespaceStub,
  ago: number,
  request: Omit<typeof RaiseCommand.Type, "ask" | "escalationId">,
) => {
  const conflictId = makeId("cfl", ulid());
  const escalationId = escalationIdOf(conflictId);
  const command = Schema.encodeSync(RaiseCommand)({
    ...request,
    escalationId,
    ask: {
      question: "Which holds?",
      options: [
        { id: PREMISE_HOLDS, label: "The premise holds", consequence: "one gives way" },
        { id: EFFECT_STANDS, label: "The effect stands", consequence: "the other does" },
      ],
      about: { kind: "conflict", id: conflictId },
      category: "ambiguous-requirement",
      evidence: [],
      precedents: [],
      default: PREMISE_HOLDS,
    },
  });
  return runInDurableObject(stub, async (instance: NamespaceDO, state) => {
    const own: unknown = Reflect.get(instance, "runtime");
    Reflect.set(
      instance,
      "runtime",
      ManagedRuntime.make(
        Layer.merge(backbone(state.storage), makeManualClock(Date.now() - ago).layer),
      ),
    );
    try {
      const { escalation } = ok(decodeExit(NamespaceCodecs.raise, await instance.raise(command)));
      return { ...escalation, armed: wideningsIn(state.storage, [escalationId]) };
    } finally {
      Reflect.set(instance, "runtime", own);
    }
  });
};

/**
 * An escalation's widening deadline run now, whatever time it is armed for:
 * its row is brought to the present and the object's own alarm handler run in
 * the same turn, so the platform's timer does not decide when.
 */
const deadlineNow = (stub: NamespaceStub, escalationId: string) =>
  runInDurableObject(stub, async (instance: NamespaceDO, state) => {
    await scheduleAlarm(state.storage, {
      kind: "deadline",
      reason: widening(escalationId),
      at: Date.now(),
    });
    await instance.alarm();
  });

/** What the namespace's object has committed on an escalation. */
const committedOn = (stub: NamespaceStub, escalationId: EscalationId) =>
  runInDurableObject(stub, (instance: NamespaceDO) =>
    instance["runtime"].runPromise(
      Effect.map(EventOutbox, (outbox) =>
        outbox.log({ kind: "escalation", id: escalationId }).map((event) => event.type),
      ),
    ),
  );

interface FeedPage {
  readonly items: readonly {
    readonly type: string;
    readonly payload: { readonly escalationId?: string };
  }[];
  readonly nextCursor: string;
}

describe("[t35.widened-real] a question passing to its namespace's maintainers, on the real namespace object", () => {
  it("[t35.widened-real] arms its deadline with the raise and withdraws it with the ruling; come due through the object's own alarm it commits EscalationWidened once, which a member's feed read serves and a visitor's does not", async () => {
    const p = await project();
    await p.open();
    const member = await seedUser(uniqueHandle("member"));
    const sponsor = await seedUser(uniqueHandle("sponsor"));
    const ns = namespaceObject(namespaceAddress(POOL_ORG));
    const feed = async (cursor: string, token?: string) => {
      const response = await worker(
        `${BASE}/v1/events?project=${p.projectId}&cursor=${cursor}&limit=500`,
        token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      return response.json<FeedPage>();
    };
    const from = (await feed("end", member.token)).nextCursor;
    // A subject of this project raises: the object that hears a ruling's decision is a real one, in a placed project.
    const raiser = { project: p.projectId, raisedBy: `subj:${p.projectId}:${LEAF}` };
    const asking = { ...raiser, sponsor: sponsor.userId };

    // Armed with the raise, thirty minutes on, and only where a person was asked first.
    const answered = await raisedAgo(ns, 0, asking);
    const unasked = await raisedAgo(ns, 0, raiser);
    expect([answered.armed, unasked.armed]).toEqual([[owed(answered)], []]);

    // A ruling withdraws its escalation's deadline.
    await drainOutbox(ns);
    const ruling = (escalationId: EscalationId) =>
      escalations((port) =>
        port.rule({
          escalationId,
          option: EFFECT_STANDS,
          by: sponsor.userId,
          idempotencyKey: `rule-${escalationId}`,
        }),
      );
    ok(await ruling(answered.id));
    expect(await wideningsOf(ns, [answered.id])).toEqual([]);

    // A minute early, the deadline commits nothing and is armed again where it was.
    const early = await raisedAgo(ns, MAINTAINERS_AFTER_MS - 60_000, asking);
    expect(early.armed).toEqual([owed(early)]);
    await deadlineNow(ns, early.id);
    expect(await committedOn(ns, early.id)).toEqual(["EscalationRaised"]);
    expect(await wideningsOf(ns, [early.id])).toEqual([owed(early)]);

    // Thirty minutes on, the object's own alarm commits the event, and owes nothing more.
    const waiting = await raisedAgo(ns, MAINTAINERS_AFTER_MS, asking);
    expect(waiting.armed).toEqual([owed(waiting)]);
    await vi.waitFor(
      async () =>
        expect(await committedOn(ns, waiting.id)).toEqual([
          "EscalationRaised",
          "EscalationWidened",
        ]),
      WAIT,
    );
    expect(await wideningsOf(ns, [waiting.id])).toEqual([]);
    // Once: the deadline again commits nothing.
    await deadlineNow(ns, waiting.id);
    expect(await committedOn(ns, waiting.id)).toEqual(["EscalationRaised", "EscalationWidened"]);
    expect(await wideningsOf(ns, [waiting.id])).toEqual([]);

    // A member's feed read of the project serves it; a visitor's, from the same place, holds only the ruling's public decision.
    await drainOutbox(ns);
    const members = await feed(from, member.token);
    const visitors = await feed(from);
    expect(
      members.items
        .filter((event) => event.type === "EscalationWidened")
        .map((event) => event.payload.escalationId),
    ).toEqual([waiting.id]);
    expect(visitors.items.map((event) => event.type)).toEqual(["DecisionRecorded"]);
    // The Projector's view says when; the question is still open, and still the first person's to answer.
    const view = ok(await escalations((port) => port.get(waiting.id))).escalation;
    expect(view.state).toBe("open");
    expect(view.widenedAt).toBeGreaterThanOrEqual(waiting.raisedAt + MAINTAINERS_AFTER_MS);
    expect(ok(await ruling(waiting.id)).escalation.state).toBe("ruled");
    // The one still waiting is answered too, so no deadline outlives the case.
    ok(await ruling(early.id));
    expect(await wideningsOf(ns, [early.id, waiting.id])).toEqual([]);
  });
});

describe("[escalation.sponsor-own-namespace] the person asked first in an agent's own namespace, through the doorway", () => {
  it("[escalation.sponsor-own-namespace] in an agent's own namespace, where no person holds a role, the sponsor asked lists the question on a private project and rules on it, and reads nothing else members-only there; another person neither lists it nor rules", async () => {
    const bot = makeId("agt", ulid());
    const projectId = makeId("prj", ulid());
    await establishProject(projectId);
    await placeProject(projectId, bot);
    const sponsor = await seedUser(uniqueHandle("sponsor"), { role: null });
    const stranger = await seedUser(uniqueHandle("stranger"), { role: null });
    const ns = namespaceObject(namespaceAddress(bot));
    const raised = await raisedAgo(ns, 0, {
      project: projectId,
      raisedBy: `subj:${projectId}:${LEAF}`,
      sponsor: sponsor.userId,
    });
    await drainOutbox(ns);

    // Listed to the sponsor, with the project it is about, though the sponsor is no member of anything there.
    await vi.waitFor(async () => {
      const listed = await questions(sponsor.token);
      expect(listed.status).toBe(200);
      expect(listed.items.map((item) => [item.id, item.project.id])).toEqual([
        [raised.id, projectId],
      ]);
    }, WAIT);
    // Asked of nobody else: another person lists nothing, and the question is not there for them to rule.
    expect(await questions(stranger.token)).toEqual({ status: 200, items: [] });
    expect((await rule(stranger.token, raised.id, "ruling-stranger", EFFECT_STANDS)).status).toBe(
      404,
    );
    // The sponsor answers it.
    const ruled = await rule(sponsor.token, raised.id, "ruling-sponsor", EFFECT_STANDS);
    expect(ruled.status).toBe(200);
    expect(await ruled.json<Question>()).toMatchObject({
      id: raised.id,
      project: { id: projectId },
      state: "ruled",
    });
    // And reads nothing else members-only there: the project's settings are not there for them.
    expect((await get(`/v1/projects/${projectId}/settings`, sponsor.token)).status).toBe(404);
  });
});
