import {
  createProject,
  declareChange,
  readInbox,
  submissionOf,
  submitChange,
} from "@keeltown/core/application/coordination";
import { enrolAgent, exchangeToken, whoami } from "@keeltown/core/application/identity";
import { isBootstrap, Scope } from "@keeltown/core/domain/identity";
import { Effect, Result, Schema } from "effect";
import type { Operations } from "../../../generated/http/app.gen.ts";
import type { Caller, Principal } from "./caller.ts";
import { tokenError, tokenOk, whoamiError, whoamiOk } from "./mappers.ts";
import {
  bootstrapConfined,
  createProjectError,
  createProjectOk,
  enrolAgentError,
  enrolAgentOk,
  enrolInput,
} from "./operator.ts";
import { piggyback } from "./piggyback.ts";
import { notImplemented } from "./problems.ts";
import type { Runner } from "./run.ts";
import {
  changeIdInput,
  declareError,
  declareInput,
  declareOk,
  inboxOk,
  type Input,
  invalid,
  statusError,
  statusOk,
  submitError,
  submitInput,
  submitOk,
} from "./work-loop.ts";

/** Every operation not yet implemented answers the declared 503 `service.not_implemented`. */
const notYet = (caller: Caller) => notImplemented(caller.requestId);

/** The authorize middleware admitted this caller; a missing principal here is a defect, never a response. */
function principalOf(caller: Caller): Effect.Effect<Principal> {
  return caller.principal === null
    ? Effect.die(new Error("an authenticated operation ran without a principal"))
    : Effect.succeed(caller.principal);
}

const decodeScopes = Schema.decodeUnknownOption(Schema.Array(Scope));

/** What the bootstrap credential may call: enrolment, and the anonymous token exchange. */
export const BOOTSTRAP_MAY_CALL: ReadonlySet<string> = new Set([
  "Auth_exchangeToken",
  "Operator_enrolAgent",
]);

/**
 * Least privilege for the bootstrap credential: every operation but those it
 * may call answers 403 with a next action, before its handler runs. One check
 * at the handler object covers REST and MCP alike.
 */
function confineBootstrap<H extends Operations<Caller>>(handlers: H): H {
  return new Proxy(handlers, {
    get(target, operation, receiver) {
      const handler: unknown = Reflect.get(target, operation, receiver);
      if (
        typeof operation !== "string" ||
        typeof handler !== "function" ||
        BOOTSTRAP_MAY_CALL.has(operation)
      )
        return handler;
      return (caller: Caller, ...rest: readonly unknown[]) =>
        isBootstrap(caller.principal)
          ? bootstrapConfined(caller.requestId)
          : Reflect.apply(handler, target, [caller, ...rest]);
    },
  });
}

/**
 * The one handler object. The generated Hono routes and the generated MCP tools
 * both dispatch into it, so a REST call and a tool call run the same code, and
 * the same notices ride both. Lanes replace a `notYet` with a real handler as
 * they implement each operation.
 */
export function makeHandlers(run: Runner) {
  return piggyback(
    run,
    confineBootstrap({
      Auth_exchangeToken: (
        caller: Caller,
        input: {
          readonly client_id: string;
          readonly client_secret: string;
          readonly scope?: string;
        },
      ) => {
        const requested =
          input.scope === undefined
            ? undefined
            : decodeScopes(input.scope.split(" ").filter(Boolean));
        if (requested !== undefined && requested._tag === "None") {
          return {
            status: 400 as const,
            body: { error: "invalid_scope" as const, error_description: "Unknown scope." },
          };
        }
        return run(
          caller,
          exchangeToken({
            clientId: input.client_id,
            clientSecret: input.client_secret,
            ...(requested === undefined ? {} : { scopes: requested.value }),
          }).pipe(
            Effect.map(tokenOk),
            Effect.catch((error) => Effect.succeed(tokenError(error))),
          ),
        );
      },
      whoami: (caller: Caller) =>
        run(
          caller,
          principalOf(caller).pipe(
            Effect.flatMap(whoami),
            Effect.match({ onSuccess: whoamiOk, onFailure: (error) => whoamiError(caller, error) }),
          ),
        ),
      Sessions_openSession: notYet,
      declare: (caller: Caller, input: Input<"declare">) => {
        const decoded = declareInput(input);
        if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
        return run(
          caller,
          principalOf(caller).pipe(
            Effect.flatMap((principal) => declareChange(principal, decoded.success)),
            Effect.match({
              onSuccess: declareOk,
              onFailure: (error) => declareError(caller, error),
            }),
          ),
        );
      },
      Changes_getChange: notYet,
      revise: notYet,
      rely: notYet,
      nearby: notYet,
      Changes_abandon: notYet,
      sketch: notYet,
      Workspaces_refreshWorkspaceToken: notYet,
      Workspaces_releaseWorkspace: notYet,
      submit: (caller: Caller, input: Input<"submit">) => {
        const decoded = submitInput(input);
        if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
        return run(
          caller,
          principalOf(caller).pipe(
            Effect.flatMap((principal) => submitChange(principal, decoded.success)),
            Effect.match({
              onSuccess: (change) => submitOk(change, decoded.success.commitSha),
              onFailure: (error) => submitError(caller, error),
            }),
          ),
        );
      },
      status: (caller: Caller, input: Input<"status">) => {
        const changeId = changeIdInput(input.changeId);
        if (Result.isFailure(changeId)) return invalid(caller, changeId.failure);
        return run(
          caller,
          submissionOf(changeId.success, input.wait).pipe(
            Effect.match({
              onSuccess: (status) => statusOk(caller, status),
              onFailure: (error) => statusError(caller, error),
            }),
          ),
        );
      },
      Conflicts_listConflicts: notYet,
      Conflicts_getConflict: notYet,
      resolve: notYet,
      why: notYet,
      Memory_listDecisions: notYet,
      Memory_getDecision: notYet,
      inbox: (caller: Caller, input: Input<"inbox">) =>
        run(
          caller,
          principalOf(caller).pipe(
            Effect.flatMap((principal) => readInbox(principal, input.cursor, input.wait)),
            Effect.map(inboxOk),
          ),
        ),
      Inbox_listEvents: notYet,
      Views_getVerdict: notYet,
      Views_getCandidate: notYet,
      Views_listLanes: notYet,
      Views_getTrunk: notYet,
      Operator_listProjects: notYet,
      Operator_createProject: (caller: Caller, input: Input<"Operator_createProject">) =>
        run(
          caller,
          principalOf(caller).pipe(
            Effect.flatMap((principal) =>
              createProject(principal, {
                name: input.name,
                source: input.source,
                idempotencyKey: input["idempotency-key"],
              }),
            ),
            Effect.match({
              onSuccess: createProjectOk,
              onFailure: (error) => createProjectError(caller, error),
            }),
          ),
        ),
      Operator_getSettings: notYet,
      Operator_putSettings: notYet,
      Operator_enrolAgent: (caller: Caller, input: Input<"Operator_enrolAgent">) => {
        const decoded = enrolInput(input);
        if (Result.isFailure(decoded)) return invalid(caller, decoded.failure);
        return run(
          caller,
          principalOf(caller).pipe(
            Effect.flatMap((principal) => enrolAgent(principal, decoded.success)),
            Effect.match({
              onSuccess: enrolAgentOk,
              onFailure: (error) => enrolAgentError(caller, error),
            }),
          ),
        );
      },
      Operator_listEscalations: notYet,
      Operator_giveRuling: notYet,
    } satisfies Operations<Caller>),
  );
}

export type Handlers = ReturnType<typeof makeHandlers>;
