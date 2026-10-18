import type { IdempotencyConflict } from "@keeltown/core/domain/identity";
import type { Issue, IssueComment, IssueNotFound } from "@keeltown/core/domain/issues";
import { AgentId, agentActor, type CommandActor, UserId, userActor } from "@keeltown/core/kernel";
import { AgentDirectory, Issues, Users } from "@keeltown/core/ports";
import { Effect, Option, Schema } from "effect";
import type {
  CloseIssueResult,
  CommentOnIssueResult,
  IssueResult,
  IssuesResult,
  OpenIssueResult,
  Operations,
  ReopenIssueResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { projectIn } from "./decisions.ts";
import { problem } from "./problems.ts";
import type { Runner } from "./run.ts";

type Input<A extends keyof Operations<Caller>> = Parameters<Operations<Caller>[A]>[1];

const iso = (ms: number) => new Date(ms).toISOString();

/** The issues a page holds when the caller names no limit. */
export const ISSUES_PAGE = 30;

/** The handles of the people and agents an answer names, by how each is named. */
type Handles = ReadonlyMap<CommandActor, string>;

const decodeUserId = Schema.decodeUnknownOption(UserId);
const decodeAgentId = Schema.decodeUnknownOption(AgentId);

/** One actor's handle, where it has one: a person's own, an agent's given handle, or the name it was enrolled by. */
const handleOf = (actor: CommandActor) => {
  const [kind, id] = actor.split(":");
  if (kind === "user")
    return Option.match(decodeUserId(id), {
      onNone: () => Effect.succeed(undefined),
      onSome: (userId) =>
        Users.use((users) => users.principal(userId)).pipe(
          Effect.map((found) => Option.getOrUndefined(found)?.handle),
        ),
    });
  return Option.match(decodeAgentId(id), {
    onNone: () => Effect.succeed(undefined),
    onSome: (agentId) =>
      AgentDirectory.use((directory) => directory.findAgent(agentId)).pipe(
        Effect.map((found) => {
          const agent = Option.getOrUndefined(found);
          return agent?.handle ?? agent?.name;
        }),
      ),
  });
};

/** The handle of each actor named, each read once. */
const handlesOf = (actors: Iterable<CommandActor | undefined>) =>
  Effect.gen(function* () {
    const handles = new Map<CommandActor, string>();
    for (const actor of new Set(actors)) {
      if (actor === undefined) continue;
      const handle = yield* handleOf(actor);
      if (handle !== undefined) handles.set(actor, handle);
    }
    return handles;
  });

const withAuthorHandle = (handle: string | undefined) =>
  handle === undefined ? {} : { authorHandle: handle };
const withClosedByHandle = (handle: string | undefined) =>
  handle === undefined ? {} : { closedByHandle: handle };

/** An issue as the API shows it, with the handles of who opened it and who closed it. */
export const issueView = (issue: Issue, handles: Handles) => ({
  issueId: issue.issueId,
  projectId: issue.projectId,
  number: issue.number,
  title: issue.title,
  body: issue.body,
  author: issue.author,
  ...withAuthorHandle(handles.get(issue.author)),
  state: issue.state,
  openedAt: iso(issue.openedAt),
  updatedAt: iso(issue.updatedAt),
  comments: issue.comments,
  ...(issue.closedReason === undefined ? {} : { closedReason: issue.closedReason }),
  ...(issue.closedBy === undefined
    ? {}
    : { closedBy: issue.closedBy, ...withClosedByHandle(handles.get(issue.closedBy)) }),
  ...(issue.closedByChange === undefined ? {} : { closedByChange: issue.closedByChange }),
  ...(issue.closedAt === undefined ? {} : { closedAt: iso(issue.closedAt) }),
});

const commentView = (comment: IssueComment, handles: Handles) => ({
  commentId: comment.commentId,
  issueId: comment.issueId,
  author: comment.author,
  ...withAuthorHandle(handles.get(comment.author)),
  body: comment.body,
  at: iso(comment.at),
});

/** An issue's view, its handles read. */
const shown = (issue: Issue) =>
  Effect.map(handlesOf([issue.author, issue.closedBy]), (handles) => issueView(issue, handles));

/** Who the policy let through, as an issue's events name them. */
const actorOf = (caller: Caller): CommandActor => {
  const { principal } = caller;
  if (principal._tag === "User") return userActor(principal.userId);
  if (principal._tag === "Agent") return agentActor(principal.agentId);
  throw new Error("an issue's write ran for a caller the policy refuses");
};

const issueNotFound = (caller: Caller, error: IssueNotFound) => ({
  status: 404 as const,
  body: problem(404, "issue.not_found", caller.requestId, {
    detail: `The project has no issue #${error.number}.`,
    nextActions: [
      { kind: "read" as const, title: "List the project's issues", operationId: "issues" },
    ],
  }),
});

const idempotencyConflict = (caller: Caller, error: IdempotencyConflict) => ({
  status: 409 as const,
  body: problem(409, "request.idempotency_conflict", caller.requestId, {
    detail: `Idempotency-Key ${error.idempotencyKey} was already used for another request on this project's issues.`,
    nextActions: [{ kind: "call" as const, title: "Send the request again with a fresh key" }],
  }),
});

const moveError = (caller: Caller, error: IssueNotFound | IdempotencyConflict) =>
  error._tag === "IssueNotFound"
    ? issueNotFound(caller, error)
    : idempotencyConflict(caller, error);

/** The project of the issue the call was decided on, as `authorizeHandlers` resolved it. */
function issueProject(caller: Caller) {
  const resource = caller.resource;
  if (resource?._tag !== "Issue" || resource.project._tag !== "Project")
    throw new Error("an issue's operation ran without its issue resolved");
  return resource.project.projectId;
}

/**
 * A project's issues, in the project's own object. The policy decided each on
 * the project, and a close or a reopen on the issue itself (its author, or
 * whoever maintains the project), before any of these runs.
 */
export function issueHandlers(run: Runner) {
  return {
    issues: (caller: Caller, input: Input<"issues">) =>
      run(
        caller,
        Effect.gen(function* () {
          const page = yield* Issues.use((issues) =>
            issues.list({
              projectId: projectIn(caller).projectId,
              state: input.state,
              before: input.before,
              limit: input.limit ?? ISSUES_PAGE,
            }),
          );
          const handles = yield* handlesOf(page.items.flatMap((i) => [i.author, i.closedBy]));
          return {
            status: 200,
            body: {
              items: page.items.map((issue) => issueView(issue, handles)),
              ...(page.next === undefined ? {} : { next: page.next }),
              open: page.open,
              closed: page.closed,
            },
          } satisfies IssuesResult;
        }),
      ),
    issue: (caller: Caller, input: Input<"issue">) =>
      run(
        caller,
        Issues.use((issues) => issues.get(projectIn(caller).projectId, input.number)).pipe(
          Effect.flatMap((thread) =>
            Effect.map(
              handlesOf([
                thread.issue.author,
                thread.issue.closedBy,
                ...thread.comments.map((comment) => comment.author),
              ]),
              (handles): IssueResult => ({
                status: 200,
                body: {
                  issue: issueView(thread.issue, handles),
                  comments: thread.comments.map((comment) => commentView(comment, handles)),
                },
              }),
            ),
          ),
          Effect.catchTag("IssueNotFound", (error) => Effect.succeed(issueNotFound(caller, error))),
        ),
      ),
    openIssue: (caller: Caller, input: Input<"openIssue">) =>
      run(
        caller,
        Issues.use((issues) =>
          issues.open({
            projectId: projectIn(caller).projectId,
            title: input.title,
            body: input.body ?? "",
            author: actorOf(caller),
            idempotencyKey: input["idempotency-key"],
          }),
        ).pipe(
          Effect.flatMap(shown),
          Effect.map((body): OpenIssueResult => ({ status: 201, body })),
          Effect.catchTag("IdempotencyConflict", (error) =>
            Effect.succeed(idempotencyConflict(caller, error)),
          ),
        ),
      ),
    commentOnIssue: (caller: Caller, input: Input<"commentOnIssue">) =>
      run(
        caller,
        Issues.use((issues) =>
          issues.comment({
            projectId: projectIn(caller).projectId,
            number: input.number,
            body: input.body,
            author: actorOf(caller),
            idempotencyKey: input["idempotency-key"],
          }),
        ).pipe(
          Effect.flatMap((comment) =>
            Effect.map(handlesOf([comment.author]), (handles): CommentOnIssueResult => ({
              status: 201,
              body: commentView(comment, handles),
            })),
          ),
          Effect.catch((error) => Effect.succeed(moveError(caller, error))),
        ),
      ),
    closeIssue: (caller: Caller, input: Input<"closeIssue">) =>
      run(
        caller,
        Issues.use((issues) =>
          issues.close({
            projectId: issueProject(caller),
            number: input.number,
            reason: input.reason ?? "completed",
            by: actorOf(caller),
            idempotencyKey: input["idempotency-key"],
          }),
        ).pipe(
          Effect.flatMap(shown),
          Effect.map((body): CloseIssueResult => ({ status: 200, body })),
          Effect.catch((error) => Effect.succeed(moveError(caller, error))),
        ),
      ),
    reopenIssue: (caller: Caller, input: Input<"reopenIssue">) =>
      run(
        caller,
        Issues.use((issues) =>
          issues.reopen({
            projectId: issueProject(caller),
            number: input.number,
            by: actorOf(caller),
            idempotencyKey: input["idempotency-key"],
          }),
        ).pipe(
          Effect.flatMap(shown),
          Effect.map((body): ReopenIssueResult => ({ status: 200, body })),
          Effect.catch((error) => Effect.succeed(moveError(caller, error))),
        ),
      ),
  };
}
