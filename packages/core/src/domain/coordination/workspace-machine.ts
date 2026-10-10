import { Result, Schema } from "effect";
import {
  type ChangeId,
  type CommitSha,
  type Committed,
  IllegalTransition,
  type Instant,
  type SketchId,
  type WorkspaceId,
} from "../kernel/index.ts";
import { WorkspaceNotFound, WorkspaceStateRefused } from "./errors.ts";
import {
  WorkspaceCollected,
  WorkspaceForked,
  WorkspaceGranted,
  WorkspacePushed,
  WorkspaceReassigned,
} from "./events.ts";
import type { Workspace } from "./workspace.ts";

/** The events the WorkspacePool DO commits for one workspace. */
export const WorkspaceEvent = Schema.Union([
  WorkspaceForked,
  WorkspaceGranted,
  WorkspaceReassigned,
  WorkspacePushed,
  WorkspaceCollected,
]);
export type WorkspaceEvent = typeof WorkspaceEvent.Type;

export type WorkspaceCommand =
  /** The pool's own fork call resolved: the workspace is ready at once (spike S2). */
  | { readonly _tag: "Fork"; readonly repo: string; readonly sourceRepo: string }
  | {
      readonly _tag: "Grant";
      readonly holder: ChangeId | SketchId;
      readonly expiresAt: Instant;
      readonly baseSha: CommitSha;
    }
  /** `declare --from-sketch`: the sketch's workspace passes to the change it became. */
  | { readonly _tag: "Reassign"; readonly sketchId: SketchId; readonly changeId: ChangeId }
  | { readonly _tag: "Pushed"; readonly ref: string; readonly sha: CommitSha }
  | { readonly _tag: "Collect"; readonly reason: "landed" | "withdrawn" | "expired" };

/** Facts from I/O: the time, and the workspace this decision is about. */
export interface WorkspaceFacts {
  readonly now: Instant;
  readonly workspaceId: WorkspaceId;
}

export type WorkspaceRejection = WorkspaceNotFound | WorkspaceStateRefused;

type Decision = Result.Result<readonly WorkspaceEvent[], WorkspaceRejection>;

const refuse = (workspace: Workspace, command: WorkspaceCommand): Decision =>
  Result.fail(
    new WorkspaceStateRefused({
      workspaceId: workspace.id,
      state: workspace.state,
      command: command._tag,
    }),
  );

/**
 * Decides a command on a workspace (docs/domain/state-machines.md §
 * Workspace). A ready workspace is granted exactly once: a repeated grant to
 * the same holder is a no-op (the pool mints that retry a fresh token outside
 * the domain), and one to any other holder is refused. Promotion reassigns it
 * from the sketch to the change, never to a third holder.
 */
export const decideWorkspace = (
  state: Workspace | undefined,
  command: WorkspaceCommand,
  facts: WorkspaceFacts,
): Decision => {
  if (state === undefined) {
    return command._tag === "Fork"
      ? Result.succeed([
          WorkspaceForked.make({
            workspaceId: facts.workspaceId,
            repo: command.repo,
            sourceRepo: command.sourceRepo,
          }),
        ])
      : Result.fail(new WorkspaceNotFound({ workspaceId: facts.workspaceId }));
  }
  const workspace = state;
  const workspaceId = workspace.id;
  switch (command._tag) {
    case "Fork":
      return refuse(workspace, command);
    case "Grant":
      if (workspace.state === "granted" && workspace.holder === command.holder)
        return Result.succeed([]);
      return workspace.state === "ready"
        ? Result.succeed([
            WorkspaceGranted.make({
              workspaceId,
              holder: command.holder,
              expiresAt: command.expiresAt,
              baseSha: command.baseSha,
            }),
          ])
        : refuse(workspace, command);
    case "Reassign":
      return workspace.state === "granted" && workspace.holder === command.sketchId
        ? Result.succeed([
            WorkspaceReassigned.make({
              workspaceId,
              sketchId: command.sketchId,
              changeId: command.changeId,
            }),
          ])
        : refuse(workspace, command);
    case "Pushed":
      return workspace.state === "granted"
        ? Result.succeed([
            WorkspacePushed.make({ workspaceId, ref: command.ref, sha: command.sha }),
          ])
        : refuse(workspace, command);
    case "Collect":
      // Releasing a workspace again is a no-op, as in the pool.
      if (workspace.state === "collected") return Result.succeed([]);
      return Result.succeed([WorkspaceCollected.make({ workspaceId, reason: command.reason })]);
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Workspace | undefined, event: WorkspaceEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a workspace ${state === undefined ? "not yet forked" : state.state}`,
  );
};

/** Folds one committed event into the workspace, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveWorkspace = (
  state: Workspace | undefined,
  committed: Committed<WorkspaceEvent>,
): Workspace => {
  const event = committed.payload;
  if (state === undefined) {
    return event._tag === "WorkspaceForked"
      ? { id: event.workspaceId, repo: event.repo, sourceRepo: event.sourceRepo, state: "ready" }
      : illegal(state, event);
  }
  const workspace = state;
  if (event.workspaceId !== workspace.id) return illegal(workspace, event);
  switch (event._tag) {
    case "WorkspaceForked":
      return illegal(workspace, event);
    case "WorkspaceGranted":
      return workspace.state === "ready"
        ? {
            ...workspace,
            state: "granted",
            holder: event.holder,
            expiresAt: event.expiresAt,
            baseSha: event.baseSha,
          }
        : illegal(workspace, event);
    case "WorkspaceReassigned":
      return workspace.state === "granted" && workspace.holder === event.sketchId
        ? { ...workspace, holder: event.changeId }
        : illegal(workspace, event);
    case "WorkspacePushed":
      return workspace.state === "granted" ? workspace : illegal(workspace, event);
    case "WorkspaceCollected":
      return workspace.state === "ready" || workspace.state === "granted"
        ? { ...workspace, state: "collected" }
        : illegal(workspace, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a workspace from its events in `seq` order. */
export const replayWorkspace = (
  events: readonly Committed<WorkspaceEvent>[],
): Workspace | undefined =>
  events.reduce<Workspace | undefined>((state, event) => evolveWorkspace(state, event), undefined);
