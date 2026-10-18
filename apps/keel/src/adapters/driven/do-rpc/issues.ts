import type { ProjectId } from "@keeltown/core/kernel";
import { Issues } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  type IssueRead,
  IssuesRead,
  MoveIssueCommand,
  OpenIssueCommand,
  ProjectCodecs,
} from "../../../rpc/index.ts";
import { callObject, fingerprintOf } from "./answer.ts";

/** The Project DO's methods `Issues` calls (`project:<id>`), each answering an Exit envelope. */
export interface ProjectIssuesStub {
  openIssue(command: typeof OpenIssueCommand.Encoded): Promise<unknown>;
  moveIssue(command: typeof MoveIssueCommand.Encoded): Promise<unknown>;
  issues(read: typeof IssuesRead.Encoded): Promise<unknown>;
  issue(read: typeof IssueRead.Encoded): Promise<unknown>;
}

const encodeOpen = Schema.encodeSync(OpenIssueCommand);
const encodeMove = Schema.encodeSync(MoveIssueCommand);
const encodeRead = Schema.encodeSync(IssuesRead);

/**
 * `Issues` over each project's own object, addressed by the project's id. The
 * fingerprint hashes who asks and what they asked, so a retry is told apart
 * from a reused key.
 */
export function IssuesRpc(
  project: (projectId: ProjectId) => ProjectIssuesStub,
): Layer.Layer<Issues> {
  const move = (projectId: ProjectId, asked: Omit<typeof MoveIssueCommand.Type, "fingerprint">) =>
    Effect.gen(function* () {
      const fingerprint = yield* Effect.promise(() =>
        fingerprintOf({ issue: asked.number, move: asked.move, by: asked.by }),
      );
      return yield* callObject(ProjectCodecs.moveIssue, () =>
        project(projectId).moveIssue(encodeMove({ ...asked, fingerprint })),
      );
    });
  return Layer.succeed(
    Issues,
    Issues.of({
      open: ({ projectId, title, body, author, idempotencyKey }) =>
        Effect.gen(function* () {
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({ open: title, body, author }),
          );
          return yield* callObject(ProjectCodecs.openIssue, () =>
            project(projectId).openIssue(
              encodeOpen({ title, body, author, idempotencyKey, fingerprint }),
            ),
          );
        }),
      comment: ({ projectId, number, body, author, idempotencyKey }) =>
        Effect.flatMap(
          move(projectId, { number, move: { _tag: "Comment", body }, by: author, idempotencyKey }),
          ({ comment }) =>
            comment === undefined
              ? Effect.die(`a comment on #${number} of ${projectId} answered no comment`)
              : Effect.succeed(comment),
        ),
      close: ({ projectId, number, reason, by, idempotencyKey }) =>
        Effect.map(
          move(projectId, { number, move: { _tag: "Close", reason }, by, idempotencyKey }),
          ({ issue }) => issue,
        ),
      reopen: ({ projectId, number, by, idempotencyKey }) =>
        Effect.map(
          move(projectId, { number, move: { _tag: "Reopen" }, by, idempotencyKey }),
          ({ issue }) => issue,
        ),
      list: ({ projectId, ...query }) =>
        callObject(ProjectCodecs.issues, () => project(projectId).issues(encodeRead(query))),
      get: (projectId, number) =>
        callObject(ProjectCodecs.issue, () => project(projectId).issue({ number })),
    }),
  );
}
