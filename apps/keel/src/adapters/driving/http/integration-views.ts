import type { LaneView, TrunkView } from "@keeltown/core/application/integration";
import type { ProjectId } from "@keeltown/core/kernel";
import type {
  Views_getTrunkResult,
  Views_listLanesResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem } from "./problems.ts";

/** Pure mappers for the integration views: a project's trunk and its lanes as the spec's TrunkView and LanePage. */

const iso = (ms: number) => new Date(ms).toISOString();

export function trunkOk(view: TrunkView): Extract<Views_getTrunkResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      projectId: view.projectId,
      head: view.head,
      advancedAt: iso(view.advancedAt),
      frozen: view.frozen,
    },
  };
}

/** A project the caller may read whose trunk has no head yet: it is still being made, or its start was refused. */
export function noTrunk(caller: Caller, projectId: ProjectId) {
  return {
    status: 404 as const,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: `Project ${projectId} has no trunk yet.`,
    }),
  };
}

/** A project's lanes are one page: no cursor is ever given out. */
export function lanesOk(
  lanes: readonly LaneView[],
): Extract<Views_listLanesResult, { readonly status: 200 }> {
  return {
    status: 200,
    body: {
      items: lanes.map((lane) => ({
        id: lane.id,
        projectId: lane.projectId,
        queued: lane.queued,
        inFlight: lane.inFlight,
      })),
    },
  };
}
