import {
  AgentNotAdmitted,
  AgentNotKnown,
  CredentialRejected,
  IdempotencyConflict,
  type Principal,
  ProjectNameTaken,
  QuotaExceeded,
  ScopeNotGranted,
} from "@keeltown/core/domain/identity";
import type { Change } from "@keeltown/core/domain/coordination";
import { AgentId, CommitSha, Instant, makeId } from "@keeltown/core/kernel";
import { ImportTooLarge } from "@keeltown/core/ports";
import {
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeChangesMemory,
  makeClockMemory,
  makeCodeHostMemory,
  makeAgentSignUpsMemory,
  makeEnrolmentsMemory,
  makeEventFeedMemory,
  makeIdsMemory,
  makeInboxMemory,
  makeMembershipsMemory,
  makeNamespacesMemory,
  makeProjectNamespacesMemory,
  makeProjectsMemory,
  makeProbeLedgerMemory,
  makeProbeStoreMemory,
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
  sampleOrgId,
  sampleProjectId,
  sampleSponsorId,
  makeNamespaceUsageMemory,
  deliveryMemoryLayer,
  makeVerdictsMemory,
  makePlanStoreMemory,
} from "@keeltown/testing";
import { ulid } from "ulid";
import { Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { tokenError, whoamiError } from "../../src/adapters/driving/http/mappers.ts";
import { createProjectError } from "../../src/adapters/driving/http/operator.ts";
import {
  inboxOk,
  statusOk,
  submitError,
  submitOk,
} from "../../src/adapters/driving/http/work-loop.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";

/** Sign-up is not what these cases are about: a key is never proved here. */
const NO_SIGN_UPS = {
  provenKey: async () =>
    ({ refused: "invalid_dpop_proof", detail: "no key is proved in this test" }) as const,
};

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const callerAs = (principal: Principal, token?: Caller["token"]): Caller => ({
  requestId: "req-1",
  principal,
  ...(token === undefined ? {} : { token }),
  signal: new AbortController().signal,
});
const caller = callerAs({ _tag: "Anonymous" });

describe("mappers", () => {
  it("maps every whoami error to a declared 401 problem with a way forward", () => {
    const unknown = whoamiError(caller, new AgentNotKnown({ agentId }));
    const stale = whoamiError(caller, new AgentNotAdmitted({ agentId, reason: "stale-epoch" }));
    expect([unknown.status, stale.status]).toEqual([401, 401]);
    expect(unknown.body).toMatchObject({
      code: "auth.invalid_token",
      requestId: "req-1",
      nextActions: [
        { kind: "call", operationId: "Auth_registerClient" },
        { kind: "read", title: expect.stringContaining("/start") },
      ],
    });
    expect(stale.body).toMatchObject({
      code: "auth.revoked",
      nextActions: [{ kind: "call", operationId: "Auth_exchangeToken" }],
    });
  });

  it("maps every token error to OAuth 2.0's own error shape", () => {
    expect(tokenError(new CredentialRejected())).toEqual({
      status: 401,
      body: { error: "invalid_client", error_description: expect.any(String) },
    });
    expect(tokenError(new ScopeNotGranted({ requested: ["operator"] })).body).toMatchObject({
      error: "invalid_scope",
    });
    expect(tokenError(new AgentNotAdmitted({ agentId, reason: "suspended" })).status).toBe(401);
  });

  it("maps a submit's reused Idempotency-Key to 409 with a way forward", () => {
    const reused = submitError(caller, new IdempotencyConflict({ idempotencyKey: "submit-1" }));
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({
      code: "request.idempotency_conflict",
      nextActions: [{ kind: "call", operationId: "submit" }],
    });
  });
});

/**
 * The operations still answering 503 service.not_implemented to a caller the
 * policy grants them. Shrinks, visibly, as lanes land each one.
 */
const STUBBED: string[] = [];

/**
 * A project placed in its org with settings, so the policy sees it, and the
 * two callers it grants between them every operation it lets anyone reach:
 * the project's own agent (work and reads) and an owner of its org who is also
 * the instance admin (governance).
 */
function grantedSurface() {
  const directory = makeAgentDirectoryMemory().layer;
  const clock = makeClockMemory().layer;
  const inbox = makeInboxMemory();
  const projects = makeProjectsMemory();
  projects.setSettings(sampleProjectId, {
    protectedPaths: [],
    maxBatchSize: 1,
    verification: "required",
    visibility: "private",
  });
  const places = makeProjectNamespacesMemory();
  places.places.set(sampleProjectId, {
    projectId: sampleProjectId,
    namespace: sampleOrgId,
    name: "stubs",
  });
  const rows = makeBetterAuthMemory({ orgs: [{ id: sampleOrgId, slug: "stubs" }] });
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
      deliveryMemoryLayer(),
      makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
      clock,
      makeIdsMemory().layer,
      makeChangesMemory().layer,
      inbox.layer,
      inbox.notifier,
      makeEventFeedMemory().layer,
      makeProjectViewsMemory().layer,
      makeDecisionsMemory().layer,
      makeVerdictsMemory().layer,
      makePlanStoreMemory().layer,
      makeProbeStoreMemory().layer,
      makeProbeLedgerMemory().world,
      makeCodeHostMemory().layer,
      makeUsersMemory(rows).layer,
      makeMembershipsMemory(rows).layer,
      makeNamespacesMemory(rows).layer,
      places.layer,
    ),
  );
  const agent = callerAs(
    {
      _tag: "Agent",
      agentId,
      namespace: sampleOrgId,
      projectId: sampleProjectId,
      scopes: ["agent:read", "agent:work"],
      paused: false,
      standing: {
        _tag: "Invited",
        by: { userId: sampleSponsorId, role: "member", suspended: false },
      },
    },
    {
      agentId,
      projectId: sampleProjectId,
      scopes: ["agent:read", "agent:work"],
      revocationEpoch: 0,
      org: sampleOrgId,
      sponsor: sampleSponsorId,
    },
  );
  const owner = callerAs({
    _tag: "User",
    userId: sampleSponsorId,
    handle: "stubs-owner",
    suspended: false,
    memberships: [{ org: sampleOrgId, role: "owner" }],
  });
  const handlers = makeHandlers(
    makeRunner(runtime),
    { emailCode: false, github: false },
    { origin: "https://keel.test", fresh: () => true, ...NO_SIGN_UPS },
  );
  return { runtime, handlers, callers: [agent, owner] };
}

describe("stubbed operations", () => {
  const { runtime, handlers, callers } = grantedSurface();
  // `{}` is no operation's valid input: the defects it raises past the routes' validation are logged, and expected.
  beforeAll(() => vi.spyOn(console, "error").mockImplementation(() => undefined));
  afterAll(async () => {
    vi.restoreAllMocks();
    await runtime.dispose();
  });

  /** What each caller is answered: `{}` names the project the agent works in, and nothing else. */
  const answersTo = (operation: string) =>
    Promise.all(
      callers.map(async (who) => {
        const handler: unknown = Reflect.get(handlers, operation);
        // Not valid input; an implemented handler may throw on it, which counts as not a stub.
        const result: unknown = await Promise.resolve()
          .then(() =>
            typeof handler === "function"
              ? Reflect.apply(handler, handlers, [who, { projectId: sampleProjectId }])
              : null,
          )
          .catch(() => null);
        return {
          status: result === null ? null : Reflect.get(Object(result), "status"),
          body: result === null ? null : Reflect.get(Object(result), "body"),
        };
      }),
    );

  it("answer exactly the declared 503 service.not_implemented, and only the listed ones do", async () => {
    const answers = await Promise.all(
      Object.keys(handlers).map(async (operation) => ({
        operation,
        answers: (await answersTo(operation)).filter((answer) => answer.status === 503),
      })),
    );
    const stubbed = answers.filter((answer) => answer.answers.length > 0);
    expect(stubbed.map((answer) => answer.operation).toSorted()).toEqual(STUBBED.toSorted());
    expect(stubbed.flatMap((answer) => answer.answers.map((a) => a.body))).toEqual(
      stubbed.flatMap((answer) =>
        answer.answers.map(() =>
          expect.objectContaining({ code: "service.not_implemented", requestId: "req-1" }),
        ),
      ),
    );
  });
});

describe("a status read's next actions", () => {
  const holder = makeId("agt", ulid());
  const change = (overrides: Partial<Change>): Change => ({
    id: makeId("chg", ulid()),
    agentId: holder,
    origin: "agent",
    state: "submitted",
    intent: { revision: 1, goal: "Cache permission lookups", footprint: [], premises: [] },
    lease: { id: makeId("lse", ulid()), agentId: holder, renewedAt: Instant(0), state: "active" },
    createdAt: Instant(0),
    ...overrides,
  });
  const SHA = CommitSha.make("a".repeat(40));

  it("[inbox.keep-waiting] an inbox read that ends with nothing new says so in two words and names the same read again, from its cursor, holding ten minutes", () => {
    const empty = inboxOk({ notices: [], cursor: "000000000042" });
    if (empty.status !== 200) throw new Error(`inbox answered ${empty.status}`);
    expect(empty.body.summary).toBe("Nothing new.");
    expect(empty.body.next).toEqual([
      expect.objectContaining({
        operationId: "inbox",
        args: { cursor: "000000000042", wait: 600 },
      }),
    ]);
  });

  it("[a11.not-landed] a change on its way is said to be not landed, with the inbox wait for ChangeLanded first, at submit and at every status read until it lands; a landed one says it has landed", () => {
    for (const state of ["submitted", "queued", "integrating"] as const) {
      const read = statusOk(caller, { change: change({ state }), commitSha: SHA });
      if (read.status !== 200) throw new Error(`status answered ${read.status}`);
      expect(read.body.summary).toContain(`is ${state} at aaaaaaaaaaaa, not landed`);
      expect(read.body.summary).toContain("only when your inbox says ChangeLanded");
      expect(read.body.next[0]).toMatchObject({ kind: "read", operationId: "inbox" });
    }
    const landed = statusOk(caller, { change: change({ state: "landed" }), commitSha: SHA });
    if (landed.status !== 200) throw new Error(`status answered ${landed.status}`);
    expect(landed.body.summary).toBe(`${landed.body.result.changeId} has landed at aaaaaaaaaaaa.`);
    const submitted = submitOk(change({}), SHA);
    if (submitted.status !== 202) throw new Error(`submit answered ${submitted.status}`);
    expect(submitted.body.summary).toContain("It is submitted, not landed");
    expect(submitted.body.next[0]).toMatchObject({ kind: "read", operationId: "inbox" });
  });

  it("[b11.status-next] waits on the submission only while the platform moves it; a park waits on its ruling or on an adopter", () => {
    const submitted = statusOk(caller, { change: change({}), commitSha: SHA });
    const escalated = change({
      state: "parked",
      parkReason: "awaiting-ruling",
      escalationId: makeId("esc", ulid()),
    });
    const ruling = statusOk(caller, { change: escalated, commitSha: SHA });
    const lapsed = change({ state: "parked", parkReason: "lease-lapsed" });
    const unsubmitted = statusOk(caller, { change: lapsed, commitSha: null });

    expect(submitted.status === 200 && submitted.body.next).toEqual([
      expect.objectContaining({
        operationId: "inbox",
        title: expect.stringContaining("ChangeLanded"),
      }),
      expect.objectContaining({ operationId: "status" }),
    ]);
    expect(ruling.status === 200 && ruling.body.next).toEqual([
      expect.objectContaining({
        kind: "read",
        operationId: "inbox",
        title: expect.stringContaining(escalated.escalationId ?? "?"),
      }),
    ]);
    expect(unsubmitted.status === 404 && unsubmitted.body.nextActions).toEqual([
      expect.objectContaining({ operationId: "adopt", args: { changeId: lapsed.id } }),
    ]);
  });
});

describe("a project's name that is taken", () => {
  it.each([
    { kind: "a person's own namespace", namespace: sampleSponsorId, handle: "ada" },
    { kind: "an agent's own namespace", namespace: agentId, handle: "ada-builder" },
    { kind: "an org", namespace: sampleOrgId, handle: "acme" },
  ])(
    "[project.name-taken-names-place] in $kind the refusal names the namespace by its handle",
    ({ namespace, handle }) => {
      const refused = createProjectError(
        caller,
        handle,
        new ProjectNameTaken({ namespace, name: "notes" }),
        "Empty",
      );
      expect([refused.status, refused.body]).toEqual([
        409,
        expect.objectContaining({
          code: "project.name_taken",
          title: "The namespace already has a project by that name",
          detail: `${handle} already has a project named "notes" (names ignore letter case).`,
          nextActions: [expect.objectContaining({ operationId: "Operator_createProject" })],
        }),
      ]);
    },
  );
});

describe("a history too large to start a project from", () => {
  const tooLarge = new ImportTooLarge({ projectId: "prj_x", bytes: 62_914_561, limit: 62_914_560 });

  it("[projects.fork-too-large-http] a fork is refused 403 project.import_too_large in a fork's words: the limit, no size (the read stops at the limit) and no next action", () => {
    const refused = createProjectError(caller, "ada", tooLarge, "Project");
    expect([refused.status, refused.body]).toEqual([
      403,
      expect.objectContaining({
        code: "project.import_too_large",
        detail:
          "The project's history is over 62914560 bytes, the most Keel forks in one piece. Nothing was kept, and no project was made.",
        nextActions: [],
      }),
    ]);
  });

  it("[projects.fork-too-large-http] an import of that size keeps its own sentence, with its size and the way on", () => {
    const refused = createProjectError(caller, "ada", tooLarge, "Import");
    expect([refused.status, refused.body]).toEqual([
      403,
      expect.objectContaining({
        code: "project.import_too_large",
        detail:
          "The repository's history is 62914561 bytes, and Keel imports at most 62914560 in one piece. Nothing was kept, and no project was made.",
        nextActions: [
          {
            kind: "call",
            title: "Import a smaller repository, or one branch of it with `ref`",
            operationId: "Operator_createProject",
          },
        ],
      }),
    ]);
  });
});

describe("a namespace at its limit of projects", () => {
  it("[projects.quota-http] is refused 403 quota.exceeded, naming the namespace, what it holds and its limit, with the way on, and says nothing of bytes", () => {
    const refused = createProjectError(
      caller,
      "ada",
      new QuotaExceeded({
        kind: "projects",
        reason: "limit",
        limit: 10,
        used: 10,
        requested: 1,
        nextActions: [{ kind: "escalate", title: "The org is at its projects limit (10)" }],
      }),
      "Empty",
    );
    expect([refused.status, refused.body]).toEqual([
      403,
      expect.objectContaining({
        code: "quota.exceeded",
        detail: "ada holds 10 projects, and it may hold at most 10. No project was made.",
        nextActions: [
          {
            kind: "call",
            title: "Create the project in an org you are a member of",
            operationId: "Operator_createProject",
          },
        ],
      }),
    ]);
  });

  it("[projects.quota-http-bytes] a history over the namespace's bytes still reads as bytes", () => {
    const refused = createProjectError(
      caller,
      "ada",
      new QuotaExceeded({
        kind: "repo-bytes",
        reason: "limit",
        limit: 100,
        used: 90,
        requested: 20,
        nextActions: [],
      }),
      "Import",
    );
    expect(refused.status === 403 && refused.body.detail).toContain("20 bytes");
  });
});
