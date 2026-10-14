import { why, whyAsked, type WhyTarget } from "@keeltown/core/application/memory";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import type { WhyLink } from "@keeltown/core/domain/memory";
import { Effect, Option, Result, Schema } from "effect";
import type { Operations, WhyResult } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { projectIn } from "./decisions.ts";
import { type ProblemBody, problem } from "./problems.ts";
import type { Runner } from "./run.ts";
import { invalid } from "./work-loop.ts";

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
 * Nothing in the caller's project explains what was asked. A caller with no
 * project of its own to read is told the same, so it learns nothing more.
 */
export function nothingToExplain(caller: { readonly requestId: string }, target: string) {
  return {
    status: 404 as const,
    body: problem(404, "why.nothing_to_explain", caller.requestId, {
      detail: `No active decision in your project explains ${target}.`,
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

/** The chain, with a summary naming the decisions behind it and a way to read each of the first three. */
function whyOk(target: WhyTarget, chain: readonly WhyLink[]): WhyResult {
  const decisions = chain.flatMap((link) =>
    link.record.kind === "decision" ? [link.record.id] : [],
  );
  const one = decisions.length === 1;
  return {
    status: 200,
    body: {
      ok: true,
      summary: `${decisions.length} active decision${one ? "" : "s"} explain${one ? "s" : ""} ${whyAsked(target)}, newest first: ${chain.length} records.`,
      result: { chain: chain.map((link) => ({ summary: link.summary, record: link.record })) },
      findings: [],
      next: decisions.slice(0, 3).map((decisionId) => ({
        kind: "read",
        title: `Read decision ${decisionId}`,
        operationId: "Memory_getDecision",
        args: { decisionId },
      })),
      notices: [],
      cost: {},
    },
  };
}

/**
 * `why`, read in the project the policy decided: the caller's own, never
 * one a parameter names. Its chain comes from the Projector's decision index
 * and read models.
 */
export function whyHandlers(run: Runner) {
  return {
    why: (caller: Caller, input: Input<"why">) => {
      const target = whyTarget(input);
      if (Result.isFailure(target)) return invalid(caller, target.failure);
      return run(
        caller,
        why(projectIn(caller).projectId, target.success).pipe(
          Effect.match({
            onSuccess: (chain) => whyOk(target.success, chain),
            onFailure: (error): WhyResult => nothingToExplain(caller, error.target),
          }),
        ),
      );
    },
  };
}
