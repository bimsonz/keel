import { SubjectKey } from "@keeltown/core/domain/coordination";
import { DecisionId } from "@keeltown/core/kernel";
import { Decisions, type IndexedDecision } from "@keeltown/core/ports";
import { Effect, Option, Schema } from "effect";
import type {
  Memory_getDecisionResult,
  Memory_listDecisionsResult,
  Operations,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem } from "./problems.ts";
import type { Runner } from "./run.ts";
import { eventProposition } from "./views.ts";
import { invalid } from "./work-loop.ts";

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];

const iso = (ms: number) => new Date(ms).toISOString();
const decodeSubject = Schema.decodeUnknownOption(SubjectKey);
const decodeDecisionId = Schema.decodeUnknownOption(DecisionId);

/** A decision as the API shows it: the ruling, and what it settled of the conflict it ruled. */
export const decisionView = (d: IndexedDecision) => ({
  id: d.decision.id,
  label: d.label,
  option: d.decision.option,
  summary: d.decision.summary,
  ...(d.decision.scope === undefined ? {} : { scope: d.decision.scope }),
  decidedAt: iso(d.decision.decidedAt),
  state: d.decision.state,
  escalationId: d.decision.escalationId,
  project: d.project,
  ...(d.conflictId === undefined ? {} : { conflictId: d.conflictId }),
  ...(d.subjectKey === undefined ? {} : { subject: d.subjectKey }),
  holds: d.holds.map(eventProposition),
  ...(d.against === undefined ? {} : { against: [...d.against] }),
  guards: [...d.guards],
});

/** A decision the caller may not read answers as one that does not exist. */
export function decisionNotFound(caller: { readonly requestId: string }, decisionId: string) {
  return {
    status: 404 as const,
    body: problem(404, "decision.not_found", caller.requestId, {
      detail: `No decision ${decisionId} in a project you can read.`,
      nextActions: [
        {
          kind: "read",
          title: "List the project's decisions",
          operationId: "Memory_listDecisions",
        },
      ],
    }),
  };
}

/** The project the call was decided on, as `authorizeHandlers` resolved it. */
function projectIn(caller: Caller) {
  if (caller.resource?._tag !== "Project")
    throw new Error("a project's operation ran without its project resolved");
  return caller.resource;
}

/**
 * Keel's decisions, read from the Projector's index. The policy decided the
 * read on a project: the list's own, and for one decision the project it was
 * ruled in, so a decision is read only by whoever may read that project.
 */
export function decisionHandlers(run: Runner) {
  return {
    Memory_listDecisions: (caller: Caller, input: Input<"Memory_listDecisions">) => {
      const subject = input.subject === undefined ? undefined : decodeSubject(input.subject);
      if (subject !== undefined && Option.isNone(subject))
        return invalid(caller, [{ path: ["subject"], message: "Expected a subject key" }]);
      const cursor = input.cursor === undefined ? undefined : decodeDecisionId(input.cursor);
      if (cursor !== undefined && Option.isNone(cursor))
        return invalid(caller, [
          { path: ["cursor"], message: "Expected a cursor from an earlier page: a decision id" },
        ]);
      return run(
        caller,
        Decisions.use((decisions) =>
          decisions.list({
            project: projectIn(caller).projectId,
            ...(subject === undefined ? {} : { subject: subject.value }),
            ...(cursor === undefined ? {} : { cursor: cursor.value }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        ).pipe(
          Effect.map(
            (page) =>
              ({
                status: 200 as const,
                body: {
                  items: page.items.map(decisionView),
                  ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
                },
              }) satisfies Memory_listDecisionsResult,
          ),
        ),
      );
    },
    Memory_getDecision: (caller: Caller, input: Input<"Memory_getDecision">) =>
      run(
        caller,
        Decisions.use((decisions) => decisions.get(DecisionId.make(input.decisionId))).pipe(
          Effect.match({
            onSuccess: (decision): Memory_getDecisionResult =>
              decision.project === projectIn(caller).projectId
                ? { status: 200, body: decisionView(decision) }
                : decisionNotFound(caller, input.decisionId),
            onFailure: () => decisionNotFound(caller, input.decisionId),
          }),
        ),
      ),
  };
}
