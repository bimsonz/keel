import type { TrunkView } from "@keeltown/core/application/integration";
import type { ProjectId } from "@keeltown/core/kernel";
import type { Views_getTrunkResult } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem } from "./problems.ts";

/** Pure mappers for the integration views: a project's trunk as the spec's TrunkView. */

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
