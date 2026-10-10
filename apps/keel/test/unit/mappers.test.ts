import {
  AgentNotAdmitted,
  AgentNotKnown,
  CredentialRejected,
  IdempotencyConflict,
  ScopeNotGranted,
} from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { tokenError, whoamiError } from "../../src/adapters/driving/http/mappers.ts";
import { submitError } from "../../src/adapters/driving/http/work-loop.ts";
import { makeHandlers } from "../../src/adapters/driving/http/handlers.ts";

const agentId = Schema.decodeUnknownSync(AgentId)("agt_01JZ8PT2C4E6G8J0M2N4Q6S8V0");
const caller = { requestId: "req-1", principal: null, signal: new AbortController().signal };

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

/** The operations still answering 503 service.not_implemented. Shrinks, visibly, as lanes land each one. */
const STUBBED = [
  "Sessions_openSession",
  "Changes_getChange",
  "revise",
  "rely",
  "nearby",
  "Changes_abandon",
  "sketch",
  "Workspaces_refreshWorkspaceToken",
  "Workspaces_releaseWorkspace",
  "Conflicts_listConflicts",
  "Conflicts_getConflict",
  "resolve",
  "why",
  "Memory_listDecisions",
  "Memory_getDecision",
  "Inbox_listEvents",
  "Views_getVerdict",
  "Views_getCandidate",
  "Views_listLanes",
  "Views_getTrunk",
  "Operator_listProjects",
  "Operator_getSettings",
  "Operator_putSettings",
  "Operator_listEscalations",
  "Operator_giveRuling",
];

describe("stubbed operations", () => {
  it("answer exactly the declared 503 service.not_implemented, and only the listed ones do", async () => {
    const handlers = makeHandlers(async () => {
      throw new Error("a stub must not reach the runtime");
    });
    const answers = await Promise.all(
      Object.entries(handlers).map(async ([operation, handler]) => {
        // `{}` is not valid input; an implemented handler may throw on it, which counts as not a stub.
        const result: unknown = await Promise.resolve()
          .then(() => Reflect.apply(handler, undefined, [caller, {}]))
          .catch(() => null);
        return {
          operation,
          status: result === null ? null : Reflect.get(Object(result), "status"),
          body: result === null ? null : Reflect.get(Object(result), "body"),
        };
      }),
    );
    const stubbed = answers.filter((answer) => answer.status === 503);
    expect(stubbed.map((answer) => answer.operation).toSorted()).toEqual(STUBBED.toSorted());
    expect(stubbed.map((answer) => answer.body)).toEqual(
      stubbed.map(() =>
        expect.objectContaining({ code: "service.not_implemented", requestId: "req-1" }),
      ),
    );
  });
});
