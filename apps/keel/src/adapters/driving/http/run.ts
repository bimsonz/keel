import { NotImplemented } from "@keeltown/core/not-implemented";
import type {
  AgentDirectory,
  AgentSignUps,
  Changes,
  Clock,
  CodeHost,
  ConflictMoves,
  Enrolments,
  Escalations,
  EventFeed,
  Ids,
  Inbox,
  Memberships,
  Notifier,
  Namespaces,
  ProbeStore,
  ProjectNamespaces,
  Projects,
  ProjectViews,
  Sessions,
  Sponsorships,
  Standings,
  TokenIssuer,
  Trunks,
  Users,
} from "@keeltown/core/ports";
import { Cause, type Effect, Exit, type ManagedRuntime } from "effect";
import {
  ResponseContractError,
  UndeclaredStatusError,
} from "../../../generated/http/runtime.gen.ts";
import { describeDefect } from "../../../rpc/index.ts";
import type { Caller } from "./caller.ts";
import { notImplemented, problem, type ProblemBody, problemResponse } from "./problems.ts";

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
  | Escalations
  | ConflictMoves
  | ProbeStore
  | Enrolments
  | CodeHost
  | Sessions
  | Sponsorships
  | Standings
  | Users
  | Memberships
  | Namespaces
  | ProjectNamespaces
  | Trunks;

/**
 * One line a request that hit a defect, found by its request id: the defect's
 * name, message, stack and cause as strings, and the platform's marks on it.
 */
export function logDefect(ops: "defect" | "contract-drift", requestId: string, defect: unknown) {
  console.error(JSON.stringify({ ops, requestId, ...describeDefect(defect) }));
}

/**
 * What a request answers when something was thrown past its handler: logged in
 * one line under the request id, then 500. A response that broke its contract
 * is logged apart from a defect, and thrown on where the tests ask for it.
 */
export function answerUnhandled(error: unknown, requestId: string, rethrowContractDrift: boolean) {
  const drift = error instanceof ResponseContractError || error instanceof UndeclaredStatusError;
  logDefect(drift ? "contract-drift" : "defect", requestId, error);
  if (drift && rethrowContractDrift) throw error;
  return problemResponse(500, "internal.defect", requestId);
}

/** What a request answers with when its effect dies rather than failing with a declared error. */
export type DefectResult =
  | { readonly status: 500; readonly body: ProblemBody }
  | { readonly status: 503; readonly body: ProblemBody };

/**
 * Runs a handler's effect on the isolate runtime. The effect's error channel is
 * `never`: every declared error is already mapped to a response. What remains
 * is a defect: `NotImplemented` (recognised by class, never by message) answers
 * the declared 503 `service.not_implemented`; an interruption answers 503; any
 * other defect is logged and answers 500 with the request id as incident id.
 */
export type Runner = <A>(
  caller: Caller,
  effect: Effect.Effect<A, never, IsolateServices>,
) => Promise<A | DefectResult>;

export function makeRunner(runtime: ManagedRuntime.ManagedRuntime<IsolateServices, never>): Runner {
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
    logDefect("defect", caller.requestId, defect);
    return {
      status: 500,
      body: problem(500, "internal.defect", caller.requestId, {
        detail: `Incident ${caller.requestId}.`,
      }),
    };
  };
}
