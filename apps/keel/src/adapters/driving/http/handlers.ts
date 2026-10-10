import type { Operations } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { notImplemented } from "./problems.ts";

/** Every operation not yet implemented answers the declared 503 `service.not_implemented`. */
const notYet = (caller: Caller) => notImplemented(caller.requestId);

/**
 * The one handler object. The generated Hono routes and the generated MCP tools
 * both dispatch into it, so a REST call and a tool call run the same code.
 * Lanes replace a `notYet` with a real handler as they implement each operation.
 */
export function makeHandlers() {
  return {
    Auth_exchangeToken: notYet,
    whoami: notYet,
    Sessions_openSession: notYet,
    declare: notYet,
    Changes_getChange: notYet,
    revise: notYet,
    rely: notYet,
    nearby: notYet,
    Changes_abandon: notYet,
    sketch: notYet,
    Workspaces_refreshWorkspaceToken: notYet,
    Workspaces_releaseWorkspace: notYet,
    submit: notYet,
    Submissions_getSubmission: notYet,
    Conflicts_listConflicts: notYet,
    Conflicts_getConflict: notYet,
    resolve: notYet,
    why: notYet,
    Memory_listDecisions: notYet,
    Memory_getDecision: notYet,
    inbox: notYet,
    Inbox_listEvents: notYet,
    Views_getVerdict: notYet,
    Views_getCandidate: notYet,
    Views_listLanes: notYet,
    Views_getTrunk: notYet,
    Operator_listProjects: notYet,
    Operator_createProject: notYet,
    Operator_getSettings: notYet,
    Operator_putSettings: notYet,
    Operator_enrolAgent: notYet,
    Operator_listEscalations: notYet,
    Operator_giveRuling: notYet,
  } satisfies Operations<Caller>;
}

export type Handlers = ReturnType<typeof makeHandlers>;
