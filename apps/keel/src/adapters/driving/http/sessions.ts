import type {
  AgentNotAdmitted,
  AgentNotKnown,
  IdempotencyConflict,
} from "@keeltown/core/domain/identity";
import type { Session } from "@keeltown/core/domain/memory";
import type { OpenSessionInput } from "@keeltown/core/ports";
import type { Sessions_openSessionResult } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { admissionRefused, runView } from "./mappers.ts";
import { problem } from "./problems.ts";
import type { Input } from "./work-loop.ts";

/** Pure mappers for `POST /v1/sessions`. */

export function sessionInput(input: Input<"Sessions_openSession">): OpenSessionInput {
  return {
    ...(input.harness === undefined ? {} : { harness: input.harness }),
    ...(input.model === undefined ? {} : { model: input.model }),
    idempotencyKey: input["idempotency-key"],
  };
}

export function sessionOk(session: Session): Sessions_openSessionResult {
  return {
    status: 201,
    body: {
      id: session.id,
      agentId: session.agentId,
      ...(session.sponsor === undefined ? {} : { sponsor: session.sponsor }),
      ...(session.run === undefined ? {} : { run: runView(session.run) }),
      openedAt: new Date(session.openedAt).toISOString(),
    },
  };
}

export function sessionError(
  caller: Caller,
  error: AgentNotKnown | AgentNotAdmitted | IdempotencyConflict,
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
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}
