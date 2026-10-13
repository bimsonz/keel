import { NotImplemented } from "@keeltown/core/not-implemented";
import type {
  AgentDirectory,
  AgentSignUps,
  Changes,
  Clock,
  CodeHost,
  ConflictMoves,
  Enrolments,
  Decisions,
  Escalations,
  EventFeed,
  Ids,
  Inbox,
  Memberships,
  Notifier,
  Namespaces,
  ProbeStore,
  NamespaceUsage,
  ProjectNamespaces,
  Projects,
  ProjectViews,
  RepoServer,
  Sessions,
  Sponsorships,
  Invitations,
  NamespaceAgents,
  ProjectAgents,
  Standings,
  TokenIssuer,
  Lanes,
  Trunks,
  Users,
  WorkspacePool,
} from "@keeltown/core/ports";
import { Cause, type Effect, Exit, type ManagedRuntime } from "effect";
import {
  ResponseContractError,
  UndeclaredStatusError,
} from "../../../generated/http/runtime.gen.ts";
import { describeDefect } from "../../../rpc/index.ts";
import type { Caller } from "./caller.ts";
import {
  DATABASE_AWAY,
  notImplemented,
  problem,
  type ProblemBody,
  problemResponse,
  unavailable,
  unavailableResult,
} from "./problems.ts";

/** The services the isolate runtime provides to use-cases reached over HTTP and MCP. */
export type IsolateServices =
  | AgentDirectory
  | AgentSignUps
  | TokenIssuer
  | Clock
  | Ids
  | Changes
  | EventFeed
  | Inbox
  | Notifier
  | Projects
  | ProjectViews
  | Decisions
  | Escalations
  | ConflictMoves
  | ProbeStore
  | Enrolments
  | CodeHost
  | Sessions
  | Sponsorships
  | Invitations
  | NamespaceAgents
  | ProjectAgents
  | Standings
  | Users
  | Memberships
  | Namespaces
  | ProjectNamespaces
  | Trunks
  | Lanes
  | NamespaceUsage
  | RepoServer
  | WorkspacePool;

/**
 * Whether what a request died of is the database being away for a moment.
 * The composition root hands the doorway this: what "away" reads like is the
 * database adapter's to know.
 */
export type DatabaseAway = (error: unknown) => boolean;

/**
 * One line a request that hit a defect, found by its request id: the defect's
 * name, message, stack and cause as strings, and the platform's marks on it.
 * A database that was away is logged apart: it is no defect of Keel's.
 */
export function logDefect(
  ops: "defect" | "contract-drift" | "d1-unavailable",
  requestId: string,
  defect: unknown,
) {
  console.error(JSON.stringify({ ops, requestId, ...describeDefect(defect) }));
}

/**
 * What a request answers when something was thrown past its handler: logged in
 * one line under the request id, then 500. A response that broke its contract
 * is logged apart from a defect, and thrown on where the tests ask for it. A
 * database that was away is neither: the request is told to come again, 503
 * with a wait. That is where a throw in the gate lands, the session's read
 * and the principal's among them.
 */
export function answerUnhandled(
  error: unknown,
  requestId: string,
  rethrowContractDrift: boolean,
  away: DatabaseAway = () => false,
) {
  if (away(error)) {
    logDefect("d1-unavailable", requestId, error);
    return unavailable(requestId, DATABASE_AWAY);
  }
  const drift = error instanceof ResponseContractError || error instanceof UndeclaredStatusError;
  logDefect(drift ? "contract-drift" : "defect", requestId, error);
  if (drift && rethrowContractDrift) throw error;
  return problemResponse(500, "internal.defect", requestId);
}

/** What a request answers with when its effect dies rather than failing with a declared error. */
export type DefectResult =
  | { readonly status: 500; readonly body: ProblemBody }
  | {
      readonly status: 503;
      readonly body: ProblemBody;
      readonly headers?: { readonly "retry-after": number };
    };

/**
 * Runs a handler's effect on the isolate runtime. The effect's error channel is
 * `never`: every declared error is already mapped to a response. What remains
 * is a defect: `NotImplemented` (recognised by class, never by message) answers
 * the declared 503 `service.not_implemented`; an interruption answers 503; the
 * database being away answers 503 with a wait; any other defect is logged and
 * answers 500 with the request id as incident id.
 */
export type Runner = <A>(
  caller: Caller,
  effect: Effect.Effect<A, never, IsolateServices>,
) => Promise<A | DefectResult>;

export function makeRunner(
  runtime: ManagedRuntime.ManagedRuntime<IsolateServices, never>,
  away: DatabaseAway = () => false,
): Runner {
  return async (caller, effect) => {
    const exit = await runtime.runPromiseExit(effect, { signal: caller.signal });
    if (Exit.isSuccess(exit)) return exit.value;
    const defect = Cause.squash(exit.cause);
    if (defect instanceof NotImplemented) return notImplemented(caller.requestId);
    if (Cause.hasInterrupts(exit.cause)) {
      return {
        status: 503,
        body: problem(503, "service.unavailable", caller.requestId, {
          detail: "The request was interrupted.",
        }),
      };
    }
    if (away(defect)) {
      logDefect("d1-unavailable", caller.requestId, defect);
      return unavailableResult(caller.requestId, DATABASE_AWAY);
    }
    logDefect("defect", caller.requestId, defect);
    return {
      status: 500,
      body: problem(500, "internal.defect", caller.requestId, {
        detail: `Incident ${caller.requestId}.`,
      }),
    };
  };
}
