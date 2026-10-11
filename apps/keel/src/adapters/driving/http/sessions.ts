import type {
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
  SessionSponsorRefused,
} from "@keeltown/core/domain/identity";
import type { Session } from "@keeltown/core/domain/memory";
import type { OpenSessionInput } from "@keeltown/core/ports";
import type { Sessions_openSessionResult } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { admissionRefused } from "./mappers.ts";
import { problem } from "./problems.ts";
import type { Input } from "./work-loop.ts";

/** Pure mappers for `POST /v1/sessions`. */

export function sessionInput(input: Input<"Sessions_openSession">): OpenSessionInput {
  return {
    ...(input.harness === undefined ? {} : { harness: input.harness }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.onBehalfOf === undefined ? {} : { onBehalfOf: input.onBehalfOf }),
    idempotencyKey: input["idempotency-key"],
  };
}

export function sessionOk(session: Session): Sessions_openSessionResult {
  return {
    status: 201,
    body: {
      id: session.id,
      agentId: session.agentId,
      ...(session.onBehalfOf === undefined ? {} : { onBehalfOf: session.onBehalfOf }),
      openedAt: new Date(session.openedAt).toISOString(),
    },
  };
}

export function sessionError(
  caller: Caller,
  error: AgentNotKnown | AgentNotAdmitted | IdempotencyConflict | SessionSponsorRefused,
): Sessions_openSessionResult {
  switch (error._tag) {
    // The gate admitted the caller a moment ago, so these are races, answered as whoami answers them.
    case "AgentNotKnown":
    case "AgentNotAdmitted":
      return admissionRefused(caller, error);
    case "IdempotencyConflict":
      return {
        status: 409,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Idempotency-Key ${error.idempotencyKey} already opened a session with another body.`,
          nextActions: [
            {
              kind: "call",
              title: "Open the session with a fresh Idempotency-Key",
              operationId: "Sessions_openSession",
            },
          ],
        }),
      };
    case "SessionSponsorRefused":
      return {
        status: 403,
        body: problem(403, "session.sponsor_refused", caller.requestId, {
          detail:
            error.sponsor === undefined
              ? `${error.agentId} has no sponsor, and an agent never names its own: ${error.requested} is refused.`
              : `${error.agentId} acts for ${error.sponsor}, not ${error.requested}.`,
          nextActions: [
            error.sponsor === undefined
              ? {
                  kind: "call",
                  title: "Open the session without onBehalfOf",
                  operationId: "Sessions_openSession",
                }
              : {
                  kind: "call",
                  title: `Open the session on behalf of ${error.sponsor}, or without onBehalfOf`,
                  operationId: "Sessions_openSession",
                  args: { onBehalfOf: error.sponsor },
                },
          ],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}
