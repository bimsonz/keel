import type {
  PlacedEscalation,
  PlacedEscalationPage,
} from "@keeltown/core/application/coordination";
import type { EscalationNotFound } from "@keeltown/core/domain/verification";
import { EscalationId } from "@keeltown/core/kernel";
import type { EscalationListRead, RulingCommand, RulingRefusal } from "@keeltown/core/ports";
import { Result, Schema } from "effect";
import type {
  Operator_giveRulingResult,
  Operator_listEscalationsResult,
} from "../../../generated/http/app.gen.ts";
import { problem, type ProblemBody } from "./problems.ts";
import { apiActions, type Input, reusedKey } from "./work-loop.ts";

/**
 * Pure mappers for the questions Keel puts to people: `GET /v1/escalations`
 * (an agent's project, or a person's inbox across projects) and
 * `POST /v1/escalations/{escalationId}/ruling`.
 */

type Issues = NonNullable<ProblemBody["issues"]>;

const iso = (ms: number) => new Date(ms).toISOString();
const decodeEscalationId = Schema.decodeUnknownOption(EscalationId);

/** A list cursor: the twelve-digit position a page's `nextCursor` named. */
const CURSOR = /^\d{12}$/;

export function escalationListInput(
  input: Input<"Operator_listEscalations">,
): Result.Result<Omit<EscalationListRead, "reader" | "now">, Issues> {
  if (input.cursor !== undefined && !CURSOR.test(input.cursor))
    return Result.fail([
      { path: ["query", "cursor"], message: "Expected the nextCursor of the page before" },
    ]);
  return Result.succeed({
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

/** A ruling as its path, its key and its body give it; `by` is the caller's, added by the handler. */
export function rulingInput(
  input: Input<"Operator_giveRuling">,
): Result.Result<Omit<RulingCommand, "by">, Issues> {
  const escalationId = decodeEscalationId(input.escalationId);
  return escalationId._tag === "Some"
    ? Result.succeed({
        escalationId: escalationId.value,
        option: input.option,
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
        idempotencyKey: input["idempotency-key"],
      })
    : Result.fail([
        { path: ["path", "escalationId"], message: "Expected an escalation id (esc_…)" },
      ]);
}

/** A question as its list and its ruling both answer it: Keel's label, its project's place, and where it stands. */
const escalationView = ({ record, project }: PlacedEscalation) => {
  const { escalation, label } = record;
  return {
    id: escalation.id,
    label,
    project: { id: project.id, namespace: project.namespace, name: project.name },
    question: escalation.question,
    options: escalation.options.map((option) => ({ ...option })),
    about: { ...escalation.about },
    category: escalation.category,
    evidence: escalation.evidence.map(({ ref, ...evidence }) => ({
      ...evidence,
      ...(ref === undefined ? {} : { ref }),
    })),
    precedents: [...escalation.precedents],
    default: escalation.default,
    raisedAt: iso(escalation.raisedAt),
    state: escalation.state,
  };
};

export function escalationsOk(page: PlacedEscalationPage): Operator_listEscalationsResult {
  return {
    status: 200,
    body: {
      items: page.items.map(escalationView),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    },
  };
}

export function rulingOk(placed: PlacedEscalation): Operator_giveRulingResult {
  return { status: 200, body: escalationView(placed) };
}

/**
 * An escalation that is not there, with the way forward. The policy answers
 * an escalation of a project the caller may not see with this too
 * (`refusalResult`), so a missing question and one of a private project read
 * alike.
 */
export function escalationNotFound(
  caller: { readonly requestId: string },
  error: { readonly escalationId: string },
) {
  return {
    status: 404 as const,
    body: problem(404, "escalation.not_found", caller.requestId, {
      detail: `No escalation ${error.escalationId}.`,
      nextActions: [
        {
          kind: "read",
          title: "List the questions waiting for you",
          operationId: "Operator_listEscalations",
        },
      ],
    }),
  };
}

export function rulingError(
  caller: { readonly requestId: string },
  error: RulingRefusal,
): Operator_giveRulingResult {
  switch (error._tag) {
    case "EscalationNotFound":
      return escalationNotFound(caller, error satisfies EscalationNotFound);
    case "EscalationStateRefused":
      return {
        status: 409,
        body: problem(409, "escalation.state_refused", caller.requestId, {
          detail: `${error.escalationId} is ${error.state ?? "not open"}: it takes one ruling, while it is open.`,
          nextActions: apiActions(error.nextActions),
        }),
      };
    case "RulingOptionUnknown":
      return {
        status: 400,
        body: problem(400, "escalation.option_unknown", caller.requestId, {
          detail: `${error.escalationId} does not offer the option ${error.option}.`,
          nextActions: apiActions(error.nextActions),
        }),
      };
    case "IdempotencyConflict":
      return reusedKey(caller, error, "Operator_giveRuling", "Rule");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}
