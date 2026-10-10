import type { CollaboratorRole, Role } from "../domain/roles.ts";
import type { Visibility } from "../domain/visibility.ts";
import type { CollaboratorRecord, RepoRecord, SessionRecord, UserRecord } from "../store/types.ts";

/** The JSON shapes the API returns. Timestamps are ISO 8601 strings. */

export interface UserView {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface SessionView {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface RepoView {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly visibility: Visibility;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The caller's role on the repository, or null when they have none. */
  readonly viewerRole: Role | null;
}

export interface CollaboratorView {
  readonly username: string;
  readonly role: CollaboratorRole;
  readonly addedAt: string;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function userView(user: UserRecord): UserView {
  return { id: user.id, username: user.username, name: user.name, createdAt: iso(user.createdAt) };
}

export function sessionView(session: SessionRecord): SessionView {
  return {
    id: session.id,
    userId: session.userId,
    createdAt: iso(session.createdAt),
    expiresAt: iso(session.expiresAt),
  };
}

export function repoView(repo: RepoRecord, owner: UserRecord, viewerRole: Role | null): RepoView {
  return {
    id: repo.id,
    owner: owner.username,
    name: repo.name,
    fullName: `${owner.username}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    defaultBranch: repo.defaultBranch,
    createdAt: iso(repo.createdAt),
    updatedAt: iso(repo.updatedAt),
    viewerRole,
  };
}

export function collaboratorView(collaborator: CollaboratorRecord, user: UserRecord): CollaboratorView {
  return { username: user.username, role: collaborator.role, addedAt: iso(collaborator.addedAt) };
}
