import { proposeFromFork, updateFromFork } from "@keeltown/core/application/integration";
import type {
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotOnFork,
  NotAForkOf,
  NotAProposal,
  PoolExhausted,
  ProposalCommitMoved,
  ProposalEmpty,
  ProposalLimit,
} from "@keeltown/core/domain/coordination";
import type { IdempotencyConflict, QuotaExceeded } from "@keeltown/core/domain/identity";
import type { PushRejected } from "@keeltown/core/domain/integration";
import {
  agentActor,
  ChangeId,
  type CommandActor,
  CommitSha,
  contentHashOf,
  ProjectId,
  userActor,
} from "@keeltown/core/kernel";
import { Changes, type PackTooLarge, ProjectViews } from "@keeltown/core/ports";
import { Effect, Result, Schema } from "effect";
import type {
  ApproveProposalResult,
  CloseProposalResult,
  Operations,
  ProposalsResult,
  ProposeResult,
  RequestProposalChangesResult,
  UpdateProposalResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { projectIn } from "./decisions.ts";
import { problem } from "./problems.ts";
import type { Runner } from "./run.ts";
import { summaryBody } from "./views.ts";
import { changeBody, changeNotFound } from "./work-loop.ts";

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];

/** The proposals a page holds when the caller names no limit. */
const PROPOSALS_PAGE = 30;

/** Who the policy let through, as a proposal's events name them. */
const actorOf = (caller: Caller): CommandActor => {
  const { principal } = caller;
  if (principal._tag === "User") return userActor(principal.userId);
  if (principal._tag === "Agent") return agentActor(principal.agentId);
  throw new Error("a proposal's write ran for a caller the policy refuses");
};

/** The project of the proposal the call was decided on, as `authorizeHandlers` resolved it. */
const proposalProject = (caller: Caller) => {
  const resource = caller.resource;
  if (resource?._tag !== "ProposalChange" || resource.project._tag !== "Project")
    throw new Error("a proposal's operation ran without its proposal resolved");
  return resource.project.projectId;
};

/** The project proposed to, as `authorizeHandlers` resolved it. */
const upstreamOf = (caller: Caller) => {
  const resource = caller.resource;
  if (resource?._tag !== "Proposal" || resource.upstream._tag !== "Project")
    throw new Error("a propose ran without its project resolved");
  return resource.upstream.projectId;
};

const readProposal = (changeId: string) => ({
  kind: "read" as const,
  title: "Read the proposal as it stands",
  operationId: "change",
  args: { changeId },
});

const invalid = (caller: Caller, path: string, message: string) => ({
  status: 400 as const,
  body: problem(400, "request.invalid", caller.requestId, {
    detail: message,
    nextActions: [],
    issues: [{ path: ["body", path], message }],
  }),
});

const decodeCommit = Schema.decodeUnknownResult(CommitSha);
const decodeProject = Schema.decodeUnknownResult(ProjectId);
const decodeChange = Schema.decodeUnknownResult(ChangeId);

type ProposeRefused =
  | NotAForkOf
  | CommitNotOnFork
  | ProposalEmpty
  | ProposalLimit
  | IdempotencyConflict
  | ChangeStateRefused
  | ChangeNotFound
  | NotAProposal
  | PoolExhausted
  | PushRejected
  | PackTooLarge
  | QuotaExceeded;

/** A propose's or an update's refusals: nothing was reserved, copied or moved. */
const proposeError = (caller: Caller, error: ProposeRefused) => {
  switch (error._tag) {
    case "NotAForkOf":
      return {
        status: 409 as const,
        body: problem(409, "proposal.not_a_fork", caller.requestId, {
          detail: `${error.fork} was not forked from ${error.upstream}: a proposal comes from a fork of the project it is to.`,
          nextActions: [
            {
              kind: "call" as const,
              title: "Fork the project, land your work there, then propose from the fork",
              operationId: "Operator_createProject",
            },
          ],
        }),
      };
    case "CommitNotOnFork":
      return {
        status: 409 as const,
        body: problem(409, "proposal.commit_not_on_fork", caller.requestId, {
          detail: `The trunk of ${error.fork} does not hold ${error.commit}: only what landed in the fork is proposed.`,
          nextActions: [
            {
              kind: "call" as const,
              title: "Land the work in the fork first, then propose the commit it landed as",
              operationId: "declare",
            },
          ],
        }),
      };
    case "ProposalEmpty":
      return {
        status: 409 as const,
        body: problem(409, "proposal.empty", caller.requestId, {
          detail: `${error.commit} carries nothing past ${error.base}, where ${error.fork} last met the project.`,
          nextActions: [],
        }),
      };
    case "ProposalLimit":
      return {
        status: 409 as const,
        body: problem(409, "proposal.limit", caller.requestId, {
          detail: `You already have ${error.limit} proposals open on this project: one must land or be closed first.`,
          nextActions: [
            {
              kind: "read" as const,
              title: "List the project's open proposals",
              operationId: "proposals",
              args: { projectId: error.projectId },
            },
          ],
        }),
      };
    case "IdempotencyConflict":
      return {
        status: 409 as const,
        body: problem(409, "request.idempotency_conflict", caller.requestId, {
          detail: `Idempotency-Key ${error.idempotencyKey} was used for a different request.`,
          nextActions: [{ kind: "call" as const, title: "Send it again with a fresh key" }],
        }),
      };
    case "ChangeStateRefused":
      return {
        status: 409 as const,
        body: problem(409, "change.state_refused", caller.requestId, {
          detail: `${error.changeId} is ${error.state}, where ${error.command} is not allowed.`,
          nextActions: [readProposal(error.changeId)],
        }),
      };
    case "ChangeNotFound":
      return changeNotFound(caller, error);
    case "NotAProposal":
      return notAProposal(caller, error);
    case "PoolExhausted":
      return {
        status: 503 as const,
        headers: { "retry-after": Math.ceil(error.retryAfterMs / 1000) },
        body: problem(503, "workspace.pool_exhausted", caller.requestId, {
          detail: "Every workspace of the project is taken or still forking.",
          retryAfterMs: error.retryAfterMs,
          nextActions: [
            { kind: "wait" as const, title: "Propose again with the same Idempotency-Key shortly" },
          ],
        }),
      };
    case "PushRejected":
      return {
        status: 503 as const,
        headers: { "retry-after": 5 },
        body: problem(503, "service.unavailable", caller.requestId, {
          detail: "The proposal's workspace stayed busy while its commit was copied in.",
          retryAfterMs: 5_000,
          nextActions: [
            { kind: "wait" as const, title: "Send it again with the same Idempotency-Key shortly" },
          ],
        }),
      };
    case "PackTooLarge":
      return {
        status: 403 as const,
        body: problem(403, "project.import_too_large", caller.requestId, {
          detail: `The fork's commits are ${error.bytes} bytes, and Keel copies at most ${error.limit} in one piece.`,
          nextActions: [],
        }),
      };
    case "QuotaExceeded":
      return {
        status: 403 as const,
        body: problem(403, "quota.exceeded", caller.requestId, {
          detail: `The fork's commits are ${error.requested} bytes, and your fork's namespace has ${Math.max(0, error.limit - error.used)} of its ${error.limit} left (${error.kind}).`,
          nextActions: error.nextActions.map(({ kind, title, operationId, args }) => ({
            kind,
            title,
            ...(operationId === undefined ? {} : { operationId }),
            ...(args === undefined ? {} : { args }),
          })),
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
};

const notAProposal = (caller: Caller, error: NotAProposal) => ({
  status: 409 as const,
  body: problem(409, "change.not_a_proposal", caller.requestId, {
    detail: `${error.changeId} is no proposal: its holder moves it under its lease.`,
    nextActions: [readProposal(error.changeId)],
  }),
});

/** An approval's, a request for changes' or a close's refusals: nothing moved. */
const moveError = (
  caller: Caller,
  error:
    | ChangeNotFound
    | ChangeStateRefused
    | NotAProposal
    | ProposalCommitMoved
    | IdempotencyConflict,
) => {
  switch (error._tag) {
    case "ProposalCommitMoved":
      return {
        status: 409 as const,
        body: problem(409, "proposal.commit_moved", caller.requestId, {
          detail: `${error.changeId} carries ${error.current} now, not ${error.commit}: its proposer moved it since you read it.`,
          nextActions: [readProposal(error.changeId)],
        }),
      };
    case "NotAProposal":
      return notAProposal(caller, error);
    default:
      return proposeError(caller, error);
  }
};

/**
 * Proposals from forks, each a change of the project proposed to. The policy
 * decided who may propose (from a fork they work in, sponsored when an
 * agent), who may approve, ask for changes or close, and who moves one,
 * before any of these runs.
 */
export function proposalHandlers(run: Runner) {
  return {
    propose: (caller: Caller, input: Input<"propose">) => {
      const fork = decodeProject(input.fork);
      if (Result.isFailure(fork))
        return Promise.resolve(invalid(caller, "fork", "Expected a project id"));
      const commit = decodeCommit(input.commit);
      if (Result.isFailure(commit))
        return Promise.resolve(invalid(caller, "commit", "Expected a 40-hex commit"));
      return run(
        caller,
        proposeFromFork({
          upstream: upstreamOf(caller),
          fork: fork.success,
          proposer: actorOf(caller),
          commit: commit.success,
          goal: input.goal,
          idempotencyKey: input["idempotency-key"],
          fingerprint: contentHashOf({
            fork: fork.success,
            commit: commit.success,
            goal: input.goal,
          }),
        }).pipe(
          Effect.match({
            onSuccess: (change): ProposeResult => ({ status: 201, body: changeBody(change) }),
            onFailure: (error): ProposeResult => proposeError(caller, error),
          }),
        ),
      );
    },
    proposals: (caller: Caller, input: Input<"proposals">) =>
      run(
        caller,
        ProjectViews.use((views) =>
          views.changes({
            project: projectIn(caller).projectId,
            proposals: input.state ?? "open",
            ...(input.cursor === undefined ? {} : { cursor: Number(input.cursor) }),
            limit: input.limit ?? PROPOSALS_PAGE,
          }),
        ).pipe(
          Effect.map((page): ProposalsResult => ({
            status: 200,
            body: {
              items: page.items.map(summaryBody),
              ...(page.nextCursor === undefined ? {} : { nextCursor: String(page.nextCursor) }),
            },
          })),
        ),
      ),
    updateProposal: (caller: Caller, input: Input<"updateProposal">) => {
      const changeId = decodeChange(input.changeId);
      const commit = decodeCommit(input.commit);
      if (Result.isFailure(changeId) || Result.isFailure(commit))
        return Promise.resolve(
          invalid(caller, "commit", "Expected a change id and a 40-hex commit"),
        );
      return run(
        caller,
        updateFromFork({
          upstream: proposalProject(caller),
          changeId: changeId.success,
          proposer: actorOf(caller),
          commit: commit.success,
          ...(input.note === undefined ? {} : { note: input.note }),
          idempotencyKey: input["idempotency-key"],
        }).pipe(
          Effect.match({
            onSuccess: (change): UpdateProposalResult => ({
              status: 200,
              body: changeBody(change),
            }),
            onFailure: (error): UpdateProposalResult => proposeError(caller, error),
          }),
        ),
      );
    },
    approveProposal: (caller: Caller, input: Input<"approveProposal">) => {
      const changeId = decodeChange(input.changeId);
      const commit = decodeCommit(input.commit);
      if (Result.isFailure(changeId) || Result.isFailure(commit))
        return Promise.resolve(
          invalid(caller, "commit", "Expected a change id and a 40-hex commit"),
        );
      return run(
        caller,
        Changes.use((changes) =>
          changes.approveProposal(changeId.success, {
            by: actorOf(caller),
            commit: commit.success,
            projectId: proposalProject(caller),
            idempotencyKey: input["idempotency-key"],
          }),
        ).pipe(
          Effect.match({
            onSuccess: (change): ApproveProposalResult => ({
              status: 200,
              body: changeBody(change),
            }),
            onFailure: (error): ApproveProposalResult => moveError(caller, error),
          }),
        ),
      );
    },
    requestProposalChanges: (caller: Caller, input: Input<"requestProposalChanges">) => {
      const changeId = decodeChange(input.changeId);
      const commit = decodeCommit(input.commit);
      if (Result.isFailure(changeId) || Result.isFailure(commit))
        return Promise.resolve(
          invalid(caller, "commit", "Expected a change id and a 40-hex commit"),
        );
      return run(
        caller,
        Changes.use((changes) =>
          changes.requestProposalChanges(changeId.success, {
            by: actorOf(caller),
            commit: commit.success,
            comment: input.comment,
            projectId: proposalProject(caller),
            idempotencyKey: input["idempotency-key"],
          }),
        ).pipe(
          Effect.match({
            onSuccess: (change): RequestProposalChangesResult => ({
              status: 200,
              body: changeBody(change),
            }),
            onFailure: (error): RequestProposalChangesResult => moveError(caller, error),
          }),
        ),
      );
    },
    closeProposal: (caller: Caller, input: Input<"closeProposal">) => {
      const changeId = decodeChange(input.changeId);
      if (Result.isFailure(changeId))
        return Promise.resolve(invalid(caller, "changeId", "Expected a change id"));
      return run(
        caller,
        Changes.use((changes) =>
          changes.closeProposal(changeId.success, {
            by: actorOf(caller),
            projectId: proposalProject(caller),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            idempotencyKey: input["idempotency-key"],
          }),
        ).pipe(
          Effect.match({
            onSuccess: (change): CloseProposalResult => ({ status: 200, body: changeBody(change) }),
            onFailure: (error): CloseProposalResult => moveError(caller, error),
          }),
        ),
      );
    },
  };
}
