import type { ReadRefused } from "@keeltown/core/application/coordination";
import type { ChangeState } from "@keeltown/core/domain/coordination";
import { ProjectId } from "@keeltown/core/kernel";
import type { ChangeListPage, ChangeSummary, ViewSnapshot } from "@keeltown/core/ports";
import { Result } from "effect";
import type {
  Changes_listChangesResult,
  Inbox_getSnapshotResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem, type ProblemBody } from "./problems.ts";
import type { Input } from "./work-loop.ts";

/**
 * Pure mappers for Mission Control's views of a project: `GET /v1/changes`
 * (the change list) and `GET /v1/events/snapshot` (the snapshot at the head).
 */

type Issues = NonNullable<ProblemBody["issues"]>;

const iso = (ms: number) => new Date(ms).toISOString();

/** A change list cursor: the `#n` a page's `nextCursor` named. */
const NUMBER = /^[1-9]\d{0,8}$/;

export interface ChangeListInput {
  readonly state?: ChangeState;
  readonly project?: ProjectId;
  readonly cursor?: number;
  readonly limit?: number;
}

/** The query, with a cursor that is not a page's `nextCursor` refused as a 400 naming it. */
export function changeListInput(
  input: Input<"Changes_listChanges">,
): Result.Result<ChangeListInput, Issues> {
  if (input.cursor !== undefined && !NUMBER.test(input.cursor)) {
    return Result.fail([
      { path: ["cursor"], message: "Expected a cursor from an earlier page: a change number" },
    ]);
  }
  return Result.succeed({
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.project === undefined ? {} : { project: ProjectId.make(input.project) }),
    ...(input.cursor === undefined ? {} : { cursor: Number(input.cursor) }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

const summaryBody = (summary: ChangeSummary) => ({
  changeId: summary.changeId,
  number: summary.number,
  state: summary.state,
  ...(summary.parkReason === undefined ? {} : { parkReason: summary.parkReason }),
  agentId: summary.agentId,
  goal: summary.goal,
  revision: summary.revision,
  declaredAt: iso(summary.declaredAt),
  updatedAt: iso(summary.updatedAt),
});

export function changesOk(page: ChangeListPage): Changes_listChangesResult {
  return {
    status: 200,
    body: {
      items: page.items.map(summaryBody),
      ...(page.nextCursor === undefined ? {} : { nextCursor: String(page.nextCursor) }),
    },
  };
}

export function snapshotOk(snapshot: ViewSnapshot): Inbox_getSnapshotResult {
  return {
    status: 200,
    body: {
      cursor: snapshot.cursor,
      changes: snapshot.changes.map(summaryBody),
      ...(snapshot.trunk === undefined ? {} : { trunk: snapshot.trunk }),
    },
  };
}

/**
 * A read the caller may not make, as Keel answers it elsewhere:
 * - without a token and without `project`, the 401 an authenticated route gives;
 * - without a token, a project that is private or does not exist is the same
 *   404, as the repo reads answer, so a private project's existence does not leak;
 * - an agent asking for another project that is not public, the 403, whether
 *   or not that project exists.
 */
export function readRefused(caller: Caller, error: ReadRefused) {
  if (error._tag === "TokenRequired")
    return {
      status: 401 as const,
      body: problem(401, "auth.invalid_token", caller.requestId, {
        detail: "Without a token, name one public project with `project`.",
        nextActions: [
          {
            kind: "call",
            title: "Exchange your client credentials for a token",
            operationId: "Auth_exchangeToken",
          },
        ],
      }),
    };
  if (error._tag === "ProjectNotFound")
    return {
      status: 404 as const,
      body: problem(404, "resource.not_found", caller.requestId, {
        detail: `No project ${error.projectId}.`,
      }),
    };
  return {
    status: 403 as const,
    body: problem(403, "auth.insufficient_scope", caller.requestId, {
      detail: "An agent reads its own project or a public one; omit `project` to read its own.",
    }),
  };
}
