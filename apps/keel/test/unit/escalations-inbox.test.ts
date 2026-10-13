import {
  EFFECT_STANDS,
  escalationIdOf,
  PREMISE_HOLDS,
} from "@keeltown/core/application/coordination";
import { MAINTAINERS_AFTER_MS } from "@keeltown/core/application/memory";
import type { Principal, Role } from "@keeltown/core/domain/identity";
import {
  makeId,
  type NamespaceId,
  type OrgId,
  type ProjectId,
  type UserId,
} from "@keeltown/core/kernel";
import { HumanGate, type RaiseRequest } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeChangesMemory,
  makeCodeHostMemory,
  makeAgentSignUpsMemory,
  makeEnrolmentsMemory,
  makeEscalationsMemory,
  makeEventFeedMemory,
  makeIdsMemory,
  makeInboxMemory,
  makeManualClock,
  makeMembershipsMemory,
  makeNamespacesMemory,
  makeProbeLedgerMemory,
  makeProbeStoreMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
  makeDecisionsMemory,
  makeProjectViewsMemory,
  makeSessionsMemory,
  invitationsMemoryLayer,
  makeSponsorshipsMemory,
  makeStandingsMemory,
  makeTokenIssuerMemory,
  makeRepoServerMemory,
  makeLanesMemory,
  makeTrunksMemory,
  makeWorkspacePoolMemory,
  makeUsersMemory,
  makeNamespaceUsageMemory,
} from "@keeltown/testing";
import { Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { afterAll, describe, expect, it } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";

/** Sign-up is not what these cases are about: a key is never proved here. */
const NO_SIGN_UPS = {
  provenKey: async () =>
    ({ refused: "invalid_dpop_proof", detail: "no key is proved in this test" }) as const,
};

/**
 * The escalations inbox and the ruling, through the handlers the routes and
 * the MCP tools dispatch into, behind the one policy: three namespaces, each
 * with a project, and people placed differently in each.
 */

const ACME = makeId("org", ulid());
const BETA = makeId("org", ulid());
const GAMMA = makeId("org", ulid());
const LEDGER = makeId("prj", ulid());
const ATLAS = makeId("prj", ulid());
const QUAY = makeId("prj", ulid());
const ANN = makeId("usr", ulid());
const BOB = makeId("usr", ulid());
const CAT = makeId("usr", ulid());
const DAN = makeId("usr", ulid());
const MAY = makeId("usr", ulid());
const AGENT = makeId("agt", ulid());

function world() {
  const clock = makeManualClock();
  const escalations = makeEscalationsMemory(clock);
  const directory = makeAgentDirectoryMemory().layer;
  const inbox = makeInboxMemory();
  const projects = makeProjectsMemory();
  const places = makeProjectNamespacesMemory();
  for (const [projectId, org, name] of [
    [LEDGER, ACME, "ledger"],
    [ATLAS, BETA, "atlas"],
    [QUAY, GAMMA, "quay"],
  ] as const) {
    projects.setSettings(projectId, {
      protectedPaths: [],
      maxBatchSize: 1,
      verification: "required",
      visibility: "private",
    });
    places.places.set(projectId, { projectId, namespace: org, name });
  }
  const rows = makeBetterAuthMemory({
    orgs: [
      { id: ACME, slug: "acme" },
      { id: BETA, slug: "beta" },
      { id: GAMMA, slug: "gamma" },
    ],
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeNamespaceUsageMemory().layer,
      directory,
      projects.layer,
      makeTrunksMemory().layer,
      makeLanesMemory().layer,
      makeRepoServerMemory({ repos: new Map() }).layer,
      makeWorkspacePoolMemory().layer,
      makeEnrolmentsMemory().layer.pipe(Layer.provide(directory)),
      makeAgentSignUpsMemory().layer.pipe(Layer.provide(directory)),
      makeSessionsMemory().layer.pipe(Layer.provide(directory)),
      makeStandingsMemory().layer.pipe(Layer.provide(directory)),
      makeSponsorshipsMemory().layer.pipe(Layer.provide(directory)),
      invitationsMemoryLayer(),
      makeTokenIssuerMemory().layer.pipe(Layer.provide(clock.layer)),
      clock.layer,
      makeIdsMemory().layer,
      makeChangesMemory().layer,
      inbox.layer,
      inbox.notifier,
      makeEventFeedMemory().layer,
      makeProjectViewsMemory().layer,
      makeDecisionsMemory().layer,
      makeProbeStoreMemory().layer,
      makeProbeLedgerMemory().layer,
      escalations.layer,
      makeCodeHostMemory().layer,
      makeUsersMemory(rows).layer,
      makeMembershipsMemory(rows).layer,
      makeNamespacesMemory(rows).layer,
      places.layer,
    ),
  );
  const handlers = makeHandlers(
    makeRunner(runtime),
    { emailCode: false, github: false },
    { origin: "https://keel.test", fresh: () => true, ...NO_SIGN_UPS },
  );
  /** Raises a question about a fresh conflict of `project`, asking `sponsor` first. */
  const raise = async (
    namespace: NamespaceId,
    project: ProjectId,
    sponsor: UserId,
    question: string,
  ) => {
    const conflictId = makeId("cfl", ulid());
    const request: RaiseRequest = {
      namespace,
      escalationId: escalationIdOf(conflictId),
      project,
      sponsor,
      raisedBy: `subj:${project}:authz.session`,
      ask: {
        question,
        options: [
          { id: PREMISE_HOLDS, label: "The premise holds", consequence: "the other gives way" },
          { id: EFFECT_STANDS, label: "The effect stands", consequence: "the holder gives way" },
        ],
        about: { kind: "conflict", id: conflictId },
        category: "ambiguous-requirement",
        evidence: [{ class: "proof", summary: "a probe tells the two apart", ref: "probe:prb_1" }],
        precedents: [],
        default: PREMISE_HOLDS,
      },
    };
    await runtime.runPromise(HumanGate.use((gate) => gate.raise(request)));
    // A millisecond apart, so each is raised at its own time.
    clock.advance(1);
    return request.escalationId;
  };
  return { clock, runtime, handlers, places, raise };
}

const callerAs = (principal: Principal, token?: Caller["token"]): Caller => ({
  requestId: "req-1",
  principal,
  ...(token === undefined ? {} : { token }),
  signal: new AbortController().signal,
});
const user = (userId: UserId, memberships: readonly (readonly [OrgId, Role])[]): Caller =>
  callerAs({
    _tag: "User",
    userId,
    handle: `user-${userId.slice(-4).toLowerCase()}`,
    suspended: false,
    memberships: memberships.map(([org, role]) => ({ org, role })),
  });
const agentOf = (org: NamespaceId, projectId: ProjectId, sponsor: UserId): Caller =>
  callerAs(
    {
      _tag: "Agent",
      agentId: AGENT,
      namespace: org,
      projectId,
      scopes: ["agent:read", "agent:work"],
      paused: false,
      standing: { _tag: "Invited", by: { userId: sponsor, role: "member", suspended: false } },
    },
    {
      agentId: AGENT,
      projectId,
      scopes: ["agent:read", "agent:work"],
      revocationEpoch: 0,
      org,
      sponsor,
    },
  );

/** Ann is a plain member of acme and maintains beta; she is in gamma not at all. */
const ann = user(ANN, [
  [ACME, "member"],
  [BETA, "maintainer"],
]);

type Answer = { readonly status: number; readonly body: Record<string, unknown> };
const answer = (result: unknown): Answer => ({
  status: Number(Reflect.get(Object(result), "status")),
  body: Object(Reflect.get(Object(result), "body")),
});
const rows = (listed: Answer): readonly Record<string, unknown>[] =>
  Array.isArray(listed.body["items"]) ? listed.body["items"] : [];
const idsOf = (listed: Answer) => rows(listed).map((row) => row["id"]);

describe("the escalations inbox", () => {
  const w = world();
  afterAll(() => w.runtime.dispose());
  const list = async (who: Caller, query: object = {}) =>
    answer(await w.handlers.Operator_listEscalations(who, query));

  it("[t67.escalation-rows] a question is listed with Keel's label for it and its project's place: the namespace by its handle, the project by its name", async () => {
    const first = await w.raise(ACME, LEDGER, ANN, "Which holds for sessions?");
    const second = await w.raise(ACME, LEDGER, DAN, "Which holds for tokens?");
    const listed = await list(agentOf(ACME, LEDGER, ANN));

    expect(listed.status).toBe(200);
    expect(rows(listed)).toEqual([
      expect.objectContaining({
        id: second,
        label: "E-2",
        project: { id: LEDGER, namespace: "acme", name: "ledger" },
        question: "Which holds for tokens?",
        state: "open",
      }),
      expect.objectContaining({
        id: first,
        label: "E-1",
        project: { id: LEDGER, namespace: "acme", name: "ledger" },
        question: "Which holds for sessions?",
        default: PREMISE_HOLDS,
        options: [
          { id: PREMISE_HOLDS, label: "The premise holds", consequence: "the other gives way" },
          { id: EFFECT_STANDS, label: "The effect stands", consequence: "the holder gives way" },
        ],
        evidence: [{ class: "proof", summary: "a probe tells the two apart", ref: "probe:prb_1" }],
        precedents: [],
        category: "ambiguous-requirement",
        raisedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      }),
    ]);
    expect(listed.body["nextCursor"]).toBeUndefined();
  });

  it("[t67.session-list] a person's list spans their projects: what they are asked first at once, a namespace they maintain after thirty minutes, and nothing of a namespace they are a plain member of or not in", async () => {
    const s = world();
    const mine = await s.raise(ACME, LEDGER, ANN, "Asked of Ann, in acme");
    const dans = await s.raise(ACME, LEDGER, DAN, "Asked of Dan, in acme");
    const bobs = await s.raise(BETA, ATLAS, BOB, "Asked of Bob, in beta");
    const cats = await s.raise(GAMMA, QUAY, CAT, "Asked of Cat, in gamma");
    const inbox = async (who: Caller, query: object = {}) =>
      answer(await s.handlers.Operator_listEscalations(who, query));

    const atOnce = await inbox(ann);
    s.clock.advance(MAINTAINERS_AFTER_MS);
    const later = await inbox(ann);
    const paged = await inbox(ann, { limit: 1 });
    const next = await inbox(ann, { limit: 1, cursor: paged.body["nextCursor"] });
    const ruledOnly = await inbox(ann, { state: "ruled" });
    // Ann has left acme: she was asked first there, and reads nothing of it now.
    const left = await inbox(user(ANN, [[BETA, "maintainer"]]));
    // An agent reads its own project's, whoever was asked, and no other project's.
    const agents = await inbox(agentOf(BETA, ATLAS, BOB));
    const anonymous = await inbox(callerAs({ _tag: "Anonymous" }));
    const badCursor = await inbox(ann, { cursor: "newest" });
    await s.runtime.dispose();

    expect(atOnce.status).toBe(200);
    expect(idsOf(atOnce)).toEqual([mine]);
    // Beta's maintainers' turn has come; Dan's question in acme is not a plain member's, nor is anything of gamma.
    expect(idsOf(later)).toEqual([bobs, mine]);
    expect(rows(later).map((row) => row["project"])).toEqual([
      { id: ATLAS, namespace: "beta", name: "atlas" },
      { id: LEDGER, namespace: "acme", name: "ledger" },
    ]);
    expect(idsOf(later)).not.toContain(dans);
    expect(idsOf(later)).not.toContain(cats);
    expect(idsOf(paged)).toEqual([bobs]);
    expect(paged.body["nextCursor"]).toEqual(expect.stringMatching(/^\d{12}$/));
    expect(idsOf(next)).toEqual([mine]);
    expect(idsOf(ruledOnly)).toEqual([]);
    expect(idsOf(left)).toEqual([bobs]);
    expect(idsOf(agents)).toEqual([bobs]);
    expect(anonymous.status).toBe(401);
    expect(badCursor).toMatchObject({ status: 400, body: { code: "request.invalid" } });
  });

  it("[t67.session-list] every page of a person's list, followed by its cursor, gives each question theirs to answer exactly once", async () => {
    const s = world();
    const raised: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      raised.push(await s.raise(ACME, LEDGER, n % 2 === 0 ? ANN : DAN, `Question ${n}`));
      raised.push(await s.raise(GAMMA, QUAY, CAT, `Elsewhere ${n}`));
    }
    const seen: unknown[] = [];
    let cursor: unknown;
    let pages = 0;
    do {
      const page = answer(
        await s.handlers.Operator_listEscalations(ann, {
          limit: 3,
          ...(typeof cursor === "string" ? { cursor } : {}),
        }),
      );
      seen.push(...idsOf(page));
      cursor = page.body["nextCursor"];
      pages += 1;
    } while (cursor !== undefined && pages < 20);
    await s.runtime.dispose();

    expect(seen).toEqual([raised[8], raised[4], raised[0]]);
  });
});

describe("a ruling on an escalation", () => {
  const w = world();
  afterAll(() => w.runtime.dispose());
  const rule = async (who: Caller, escalationId: string, option: string, key: string) =>
    answer(
      await w.handlers.Operator_giveRuling(who, {
        escalationId,
        option,
        "idempotency-key": key,
      }),
    );

  it("[t67.ruling] the person asked first rules once, and is answered the question as it then stands with its label and place; the refusals each say what to do", async () => {
    const asked = await w.raise(ACME, LEDGER, ANN, "Which holds for sessions?");
    const dans = await w.raise(ACME, LEDGER, DAN, "Which holds for tokens?");
    const may = user(MAY, [[ACME, "maintainer"]]);
    const cat = user(CAT, [[GAMMA, "owner"]]);

    // Ann is a plain member of acme: asked first of one question, and not asked of the other.
    const notAsked = await rule(ann, dans, PREMISE_HOLDS, "rule-dans-1");
    const outsider = await rule(cat, asked, PREMISE_HOLDS, "rule-cat-1");
    const unknown = await rule(ann, makeId("esc", ulid()), PREMISE_HOLDS, "rule-none-1");
    const malformed = await rule(ann, "not-an-id", PREMISE_HOLDS, "rule-none-2");
    const byAgent = await rule(agentOf(ACME, LEDGER, ANN), asked, PREMISE_HOLDS, "rule-agent-1");
    const noSuchOption = await rule(may, dans, "neither", "rule-may-1");
    const ruled = await rule(ann, asked, EFFECT_STANDS, "rule-ann-1");
    const again = await rule(ann, asked, EFFECT_STANDS, "rule-ann-1");
    const otherBody = await rule(ann, asked, PREMISE_HOLDS, "rule-ann-1");
    const second = await rule(may, asked, PREMISE_HOLDS, "rule-may-2");
    // A maintainer rules what another was asked first.
    const byMaintainer = await rule(may, dans, PREMISE_HOLDS, "rule-may-3");

    expect(ruled).toEqual({
      status: 200,
      body: expect.objectContaining({
        id: asked,
        label: "E-1",
        project: { id: LEDGER, namespace: "acme", name: "ledger" },
        question: "Which holds for sessions?",
        state: "ruled",
      }),
    });
    expect(again).toEqual(ruled);
    expect(otherBody).toMatchObject({
      status: 409,
      body: {
        code: "request.idempotency_conflict",
        nextActions: [{ kind: "call", operationId: "Operator_giveRuling" }],
      },
    });
    expect(second).toMatchObject({ status: 409, body: { code: "escalation.state_refused" } });
    expect(noSuchOption).toMatchObject({
      status: 400,
      body: { code: "escalation.option_unknown" },
    });
    // Each option the question does offer is a ruling ready to send.
    expect(noSuchOption.body["nextActions"]).toEqual([
      expect.objectContaining({
        operationId: "Operator_giveRuling",
        args: expect.objectContaining({ escalationId: dans, option: PREMISE_HOLDS }),
      }),
      expect.objectContaining({
        operationId: "Operator_giveRuling",
        args: expect.objectContaining({ escalationId: dans, option: EFFECT_STANDS }),
      }),
    ]);
    expect(notAsked).toMatchObject({ status: 403, body: { code: "auth.forbidden" } });
    expect(byAgent).toMatchObject({
      status: 403,
      body: { code: "auth.forbidden", detail: "Refused: users-only." },
    });
    // From outside the namespace a question reads as one that does not exist, and so does a malformed id.
    expect(unknown).toMatchObject({ status: 404, body: { code: "escalation.not_found" } });
    expect([outsider.status, outsider.body["code"], outsider.body["nextActions"]]).toEqual([
      unknown.status,
      unknown.body["code"],
      unknown.body["nextActions"],
    ]);
    expect(malformed).toMatchObject({ status: 404, body: { code: "escalation.not_found" } });
    expect(byMaintainer).toMatchObject({
      status: 200,
      body: { id: dans, label: "E-2", state: "ruled" },
    });
  });
});
