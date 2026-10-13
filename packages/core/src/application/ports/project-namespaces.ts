import { Context, type Effect, type Option } from "effect";
import type { ProjectNameTaken } from "../../domain/identity/index.ts";
import type { NamespaceId, ProjectId } from "../../domain/kernel/index.ts";

/** Where a project lives: its namespace, and its name there, the second segment of `/<namespace>/<project>`. */
export interface ProjectPlace {
  readonly projectId: ProjectId;
  readonly namespace: NamespaceId;
  readonly name: string;
}

/**
 * Each project's namespace and name. Keel owns them, in its D1 `projects`
 * table, written when a project is created. A name is held lower-case, unique
 * in its namespace and found in any case. Assigning a project the place it has
 * is a no-op; a name another project of the namespace holds, or another place
 * for a placed project (a project never moves), is ProjectNameTaken.
 */
export class ProjectNamespaces extends Context.Service<
  ProjectNamespaces,
  {
    readonly assign: (place: ProjectPlace) => Effect.Effect<void, ProjectNameTaken>;
    readonly byId: (projectId: ProjectId) => Effect.Effect<Option.Option<ProjectPlace>>;
    readonly byName: (
      namespace: NamespaceId,
      name: string,
    ) => Effect.Effect<Option.Option<ProjectPlace>>;
    /** The namespace's projects, by name. */
    readonly inNamespace: (namespace: NamespaceId) => Effect.Effect<readonly ProjectPlace[]>;
    /** Every project on the instance, by id, up to `limit` after `after`: a page of the list anyone reads, filtered by the policy. */
    readonly all: (
      after: ProjectId | undefined,
      limit: number,
    ) => Effect.Effect<readonly ProjectPlace[]>;
  }
>()("keel/ProjectNamespaces") {}
