import { explainWhy, type WhyAnswer, whyAsked } from "@keeltown/core/application/memory";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import type { KeelRecord } from "@keeltown/core/domain/memory";
import type { WhyTarget } from "@keeltown/core/ports";
import { Effect, Option, Result, Schema } from "effect";
import type { Operations, WhyResult } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { projectIn } from "./decisions.ts";
import { type ProblemBody, problem } from "./problems.ts";
import type { Runner } from "./run.ts";
import { invalid, served } from "./work-loop.ts";

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];
type Issues = NonNullable<ProblemBody["issues"]>;

const decodeSubject = Schema.decodeUnknownOption(SubjectKey);

/**
 * What was asked: a subject, or a path with or without a line, never both
 * and never neither. A line is a line of the path, so it needs one.
 */
function whyTarget(input: Input<"why">): Result.Result<WhyTarget, Issues> {
  const { path, line, subject } = input;
  if (path !== undefined && subject !== undefined)
    return Result.fail([{ path: ["subject"], message: "Name a path or a subject, not both" }]);
  if (path !== undefined) return Result.succeed({ kind: "path", path, line });
  if (subject === undefined)
    return Result.fail([{ path: ["path"], message: "Name a path or a subject" }]);
  if (line !== undefined)
    return Result.fail([{ path: ["line"], message: "A line is read in a path, not a subject" }]);
  const key = decodeSubject(subject);
  return Option.isSome(key)
    ? Result.succeed({ kind: "subject", subject: key.value })
    : Result.fail([{ path: ["subject"], message: "Expected a subject key" }]);
}

/**
 * Nothing in the project read explains what was asked. A caller with no
 * project to read, or one it may not see, is told the same, so it learns
 * nothing more.
 */
export function nothingToExplain(caller: { readonly requestId: string }, target: string) {
  return {
    status: 404 as const,
    body: problem(404, "why.nothing_to_explain", caller.requestId, {
      detail: `No active decision in the project explains ${target}.`,
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

/** What an input the handler never read asked about: a refused caller's, told the same as one with nothing to explain. */
export function askedIn(input: unknown): string {
  const target = whyTarget(Object(input));
  return Result.isSuccess(target) ? whyAsked(target.success) : "what was asked";
}

/** Keel's record as the API serves it: each premise its message states with its strength written out. */
function recordView(record: KeelRecord) {
  const { message } = record;
  switch (message.kind) {
    case "intent":
      return { ...record, message: { ...message, premises: message.premises.map(served) } };
    case "premise":
      return { ...record, message: { ...message, premise: served(message.premise) } };
    default:
      return { ...record, message };
  }
}

/**
 * The chain, with a summary naming what explains it and a way to read each
 * of the first three: the decisions behind it, or, where none is recorded on
 * a path, the changes that landed there most recently.
 */
function whyOk(target: WhyTarget, { basis, chain }: WhyAnswer): WhyResult {
  const asked = whyAsked(target);
  const decisions = chain.flatMap((link) =>
    link.record.message.kind === "decision" ? [link.record.id] : [],
  );
  const changes = chain.flatMap((link) =>
    link.record.change === undefined ? [] : [link.record.change],
  );
  const one = (basis === "decisions" ? decisions : changes).length === 1;
  return {
    status: 200,
    body: {
      ok: true,
      summary:
        basis === "decisions"
          ? `${decisions.length} active decision${one ? "" : "s"} explain${one ? "s" : ""} ${asked}, newest first: ${chain.length} records.`
          : `No decision is recorded on ${asked}; the ${changes.length} change${one ? "" : "s"} that landed there most recently say${one ? "s" : ""} why it is as it is, newest first.`,
      result: {
        chain: chain.map((link) => ({ summary: link.summary, record: recordView(link.record) })),
      },
      findings: [],
      next:
        basis === "decisions"
          ? decisions.slice(0, 3).map((decisionId) => ({
              kind: "read",
              title: `Read decision ${decisionId}`,
              operationId: "Memory_getDecision",
              args: { decisionId },
            }))
          : changes.slice(0, 3).map((changeId) => ({
              kind: "read",
              title: `Read change ${changeId}, which landed on ${asked}`,
              operationId: "change",
              args: { changeId },
            })),
      notices: [],
      cost: {},
    },
  };
}

/**
 * `why`, read in the project the policy decided: the one `project` names, or
 * an agent's own, never one the handler reads from the input. Its chain comes
 * from the Projector's decision index and read models, in one read, and from
 * its landings by path in one more when no decision explains a path.
 */
export function whyHandlers(run: Runner) {
  return {
    why: (caller: Caller, input: Input<"why">) => {
      const target = whyTarget(input);
      if (Result.isFailure(target)) return invalid(caller, target.failure);
      return run(
        caller,
        explainWhy(projectIn(caller).projectId, target.success).pipe(
          Effect.match({
            onSuccess: (answer) => whyOk(target.success, answer),
            onFailure: (error): WhyResult => nothingToExplain(caller, error.target),
          }),
        ),
      );
    },
  };
}
