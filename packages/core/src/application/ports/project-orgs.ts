import { Context, type Effect, type Option } from "effect";
import type { ProjectNameTaken } from "../../domain/identity/index.ts";
import type { OrgId, ProjectId } from "../../domain/kernel/index.ts";

/** Where a project lives: its org, and its name there, the second segment of `/<org>/<project>`. */
export interface ProjectPlace {
  readonly projectId: ProjectId;
  readonly org: OrgId;
  readonly name: string;
}

/**
 * Each project's org and name. Keel owns them, in its D1 `projects` table,
 * written when a project is created. A name is held lower-case, unique in its
 * org and found in any case. Assigning a project the place it has is a no-op;
 * a name another project of the org holds, or another place for a placed
 * project (a project never moves), is ProjectNameTaken.
 */
export class ProjectOrgs extends Context.Service<
  ProjectOrgs,
  {
    readonly assign: (place: ProjectPlace) => Effect.Effect<void, ProjectNameTaken>;
    readonly byId: (projectId: ProjectId) => Effect.Effect<Option.Option<ProjectPlace>>;
    readonly byName: (org: OrgId, name: string) => Effect.Effect<Option.Option<ProjectPlace>>;
    /** The org's projects, by name. */
    readonly inOrg: (org: OrgId) => Effect.Effect<readonly ProjectPlace[]>;
  }
>()("keel/ProjectOrgs") {}
