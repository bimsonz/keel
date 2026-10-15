import { Context, type Effect, type Option } from "effect";
import type { Invitation, InvitationScopes } from "../../domain/identity/index.ts";
import type {
  AgentId,
  Instant,
  NamespaceId,
  ProjectId,
  UserId,
} from "../../domain/kernel/index.ts";
import type { InvitedStanding } from "./namespace-agents.ts";

/** One move of an agent's place on a project, as its event tells it. */
export type ProjectAgentMove =
  | {
      readonly _tag: "Invited";
      readonly projectId: ProjectId;
      readonly namespace: NamespaceId;
      readonly agentId: AgentId;
      readonly by: UserId;
      readonly scopes: InvitationScopes;
      readonly at: Instant;
    }
  | {
      readonly _tag: "Joined";
      readonly projectId: ProjectId;
      readonly agentId: AgentId;
      readonly at: Instant;
    }
  | { readonly _tag: "Left"; readonly projectId: ProjectId; readonly agentId: AgentId };

/**
 * The agents invited to each project of a person's own namespace, as rows the
 * request gate can read: a projection of the record every project's own
 * object keeps (the `Invitations` port moves it, given a project). It is
 * `NamespaceAgents` for one project in place of a whole namespace, and holds
 * to the same rules.
 *
 * - `apply` writes one move, guarded by `seq`, the project's event number: a
 *   move at or below the row's own changes nothing. It answers whether the row
 *   now holds that move or a later one. An acceptance or an end that finds no
 *   row answers false: its invitation has not been written yet, and the caller
 *   applies it again after that.
 * - `standing` answers only for an accepted invitation: a pending one and an
 *   ended one give nothing.
 * - `find` answers a row that stands, pending or accepted; `inProject` and
 *   `ofAgent` list those, oldest invitation first. An ended row is in none:
 *   only `ended` reads it, for the gate to tell an agent that stood there once.
 */
export class ProjectAgents extends Context.Service<
  ProjectAgents,
  {
    readonly apply: (move: ProjectAgentMove, seq: number) => Effect.Effect<boolean>;
    readonly standing: (
      agentId: AgentId,
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<InvitedStanding>>;
    readonly find: (
      agentId: AgentId,
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<Invitation>>;
    readonly inProject: (projectId: ProjectId) => Effect.Effect<readonly Invitation[]>;
    readonly ofAgent: (agentId: AgentId) => Effect.Effect<readonly Invitation[]>;
    /** Whether the agent's invitation to this project ended, and none was made since. */
    readonly ended: (agentId: AgentId, projectId: ProjectId) => Effect.Effect<boolean>;
  }
>()("keel/ProjectAgents") {}
