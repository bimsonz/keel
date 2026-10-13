import { NotImplemented } from "@keeltown/core/not-implemented";
import type {
  AgentDirectory,
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
  Users,
} from "@keeltown/core/ports";
import { Cause, type Effect, Exit, type ManagedRuntime } from "effect";
import type { Caller } from "./caller.ts";
import { notImplemented, problem, type ProblemBody } from "./problems.ts";

/** The services the isolate runtime provides to use-cases reached over HTTP and MCP. */
export type IsolateServices =
  | AgentDirectory
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
  | ProjectNamespaces;

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
    console.error("defect", { requestId: caller.requestId, defect });
    return {
      status: 500,
      body: problem(500, "internal.defect", caller.requestId, {
        detail: `Incident ${caller.requestId}.`,
      }),
    };
  };
}
