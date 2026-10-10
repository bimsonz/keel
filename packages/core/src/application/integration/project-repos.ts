import type { ProjectId } from "../../domain/kernel/index.ts";
import type { RepoRef } from "../ports/index.ts";

/** Where a project's code lives on the code host. */
export interface ProjectRepos {
  /** Trunk: written only by the Trunk DO (ADR 0003). */
  readonly trunk: RepoRef;
  /** A fork of trunk the Lane DO pushes candidates to (`refs/heads/cand/<candidateId>`). */
  readonly staging: RepoRef;
  /** The fork of trunk the WorkspacePool forks workspaces from; it lags trunk safely, because a change's base is its workspace's head. */
  readonly mirror: RepoRef;
}

/**
 * A project's repos, by convention. At L1 the namespaces belong to the
 * deployment: trunk and staging in `keel-core`, the mirror in the workspace
 * shard `keel-ws-00`, beside the workspaces forked from it. Names are the
 * project id in lower case with a hyphen (`prj-01…`), so no two projects
 * collide and every name is a valid repo name.
 */
export const projectRepos = (projectId: ProjectId): ProjectRepos => {
  const name = projectId.replace("_", "-").toLowerCase();
  return {
    trunk: { namespace: "keel-core", name },
    staging: { namespace: "keel-core", name: `${name}-staging` },
    mirror: { namespace: "keel-ws-00", name: `${name}-mirror` },
  };
};
