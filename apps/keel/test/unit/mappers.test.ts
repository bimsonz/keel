import {
  AgentNotAdmitted,
  AgentNotKnown,
  CredentialRejected,
  IdempotencyConflict,
  type Principal,
  ScopeNotGranted,
} from "@keeltown/core/domain/identity";
import type { Change } from "@keeltown/core/domain/coordination";
import { AgentId, CommitSha, Instant, makeId } from "@keeltown/core/kernel";
import {
  makeAgentDirectoryMemory,
  makeBetterAuthMemory,
  makeChangesMemory,
  makeClockMemory,
  makeCodeHostMemory,
  makeEnrolmentsMemory,
  makeEventFeedMemory,
  makeIdsMemory,
  makeInboxMemory,
  makeMembershipsMemory,
  makeOrgsMemory,
  makeProjectOrgsMemory,
  makeProjectsMemory,
  makeProjectViewsMemory,
  makeSessionsMemory,
  makeStandingsMemory,
  makeTokenIssuerMemory,
  makeUsersMemory,
  sampleOrgId,
  sampleProjectId,
  sampleSponsorId,
} from "@keeltown/testing";
import { ulid } from "ulid";
import { Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Caller } from "../../src/adapters/driving/http/caller.ts";
import { tokenError, whoamiError } from "../../src/adapters/driving/http/mappers.ts";
import { statusOk, submitError } from "../../src/adapters/driving/http/work-loop.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";
import { makeRunner } from "../../src/adapters/driving/http/run.ts";

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
    expect(unknown.body).toMatchObject({ code: "auth.invalid_token", requestId: "req-1" });
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
const STUBBED = [
  "sketch",
  "Workspaces_refreshWorkspaceToken",
  "Workspaces_releaseWorkspace",
  "Conflicts_listConflicts",
  "Conflicts_getConflict",
  "resolve",
  "why",
  "Memory_listDecisions",
  "Memory_getDecision",
  "Views_getVerdict",
  "Views_getCandidate",
  "Views_listLanes",
  "Views_getTrunk",
  "Operator_listEscalations",
];

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
  const places = makeProjectOrgsMemory();
  places.places.set(sampleProjectId, {
    projectId: sampleProjectId,
    org: sampleOrgId,
    name: "stubs",
  });
  const rows = makeBetterAuthMemory({ orgs: [{ id: sampleOrgId, slug: "stubs" }] });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      directory,
      projects.layer,
      makeEnrolmentsMemory().layer.pipe(Layer.provide(directory)),
      makeSessionsMemory().layer.pipe(Layer.provide(directory)),
      makeStandingsMemory().layer.pipe(Layer.provide(directory)),
      makeTokenIssuerMemory().layer.pipe(Layer.provide(clock)),
      clock,
      makeIdsMemory().layer,
      makeChangesMemory().layer,
      inbox.layer,
      inbox.notifier,
      makeEventFeedMemory().layer,
      makeProjectViewsMemory().layer,
      makeCodeHostMemory().layer,
      makeUsersMemory(rows).layer,
      makeMembershipsMemory(rows).layer,
      makeOrgsMemory(rows).layer,
      places.layer,
    ),
  );
  const agent = callerAs(
    {
      _tag: "Agent",
      agentId,
      org: sampleOrgId,
      projectId: sampleProjectId,
      scopes: ["agent:read", "agent:work"],
      sponsor: { userId: sampleSponsorId, role: "member", suspended: false },
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
    instanceAdmin: true,
    suspended: false,
    memberships: [{ org: sampleOrgId, role: "owner" }],
  });
  const handlers = makeHandlers(
    makeRunner(runtime),
    { emailCode: false, github: false },
    async () => {
      throw new Error("no users are made here");
    },
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

  it("Operator_giveRuling is a stub no caller reaches yet: its escalation resolves to the agent's own project, which only a user may rule on", async () => {
    const [agent, owner] = await answersTo("Operator_giveRuling");
    expect(agent).toEqual({
      status: 403,
      body: expect.objectContaining({ code: "auth.forbidden", detail: "Refused: users-only." }),
    });
    expect(owner).toEqual({
      status: 404,
      body: expect.objectContaining({ code: "resource.not_found" }),
    });
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
