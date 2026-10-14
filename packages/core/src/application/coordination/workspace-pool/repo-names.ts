import { isId, type ProjectId, type WorkspaceId } from "../../../domain/kernel/index.ts";

/**
 * A workspace's repo is named `<prj>-ws-<ulid>`, in lower case, where
 * `<prj>` is the project's own repo
 * name (`prj-<ulid>`, its trunk's). The project comes first, so a push to the
 * repo names the pool that holds it without a lookup, and the mirror
 * (`<prj>-mirror`) is never mistaken for a workspace.
 */
const projectPart = (projectId: ProjectId): string => projectId.replace("_", "-").toLowerCase();

const ulidOf = (id: string): string => id.slice(id.indexOf("_") + 1).toLowerCase();

export const workspaceRepoName = (projectId: ProjectId, workspaceId: WorkspaceId): string =>
  `${projectPart(projectId)}-ws-${ulidOf(workspaceId)}`;

/** Whose repo a name is: a workspace's, in its project. */
export type RepoOwner = {
  readonly kind: "workspace";
  readonly projectId: ProjectId;
  readonly id: WorkspaceId;
};

// Anchored from the right: the ULID is fixed-width Crockford base32 in lower case.
const NAMED = /^(?<prj>.+)-ws-(?<ulid>[0-9a-hjkmnp-tv-z]{26})$/;
const PROJECT = /^prj-(?<ulid>[0-9a-hjkmnp-tv-z]{26})$/;

/** The owner a repo name gives, or undefined for any other repo (a mirror, staging, trunk, or a name Keel never gave). */
export const ownerOfRepo = (name: string): RepoOwner | undefined => {
  const named = NAMED.exec(name)?.groups;
  const project = named?.["prj"] === undefined ? undefined : PROJECT.exec(named["prj"])?.groups;
  const projectId = `prj_${project?.["ulid"]?.toUpperCase() ?? ""}`;
  const ulid = named?.["ulid"]?.toUpperCase() ?? "";
  if (!isId("prj", projectId)) return undefined;
  const id = `wsp_${ulid}`;
  return isId("wsp", id) ? { kind: "workspace", projectId, id } : undefined;
};
