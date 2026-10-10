import type { CollaboratorRole } from "../domain/roles.ts";
import type { Visibility } from "../domain/visibility.ts";
import type { EventSource } from "../events.ts";

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly createdAt: number;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  /** SHA-256 of the bearer token. The token itself is never stored. */
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface RepoRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: Visibility;
  readonly defaultBranch: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RepoSettings {
  readonly description?: string;
  readonly defaultBranch?: string;
}

export interface CollaboratorRecord {
  readonly repoId: string;
  readonly userId: string;
  readonly role: CollaboratorRole;
  readonly addedBy: string;
  readonly addedAt: number;
}

export interface Ref {
  readonly name: string;
  readonly sha: string;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

/**
 * Persistence for forge-lite. Lookups never mutate. Every mutation emits a
 * typed event through `events` once it has been applied.
 *
 * Callers check uniqueness and existence first; mutations treat a violated
 * precondition as a programming error and throw.
 */
export interface Store {
  readonly events: EventSource;

  createUser(user: UserRecord): void;
  getUser(id: string): UserRecord | undefined;
  findUserByUsername(username: string): UserRecord | undefined;

  createSession(session: SessionRecord): void;
  findSessionByTokenHash(tokenHash: string): SessionRecord | undefined;
  deleteSession(id: string, at: number): void;

  createRepo(repo: RepoRecord): void;
  getRepo(id: string): RepoRecord | undefined;
  findRepo(ownerId: string, name: string): RepoRecord | undefined;
  listReposOwnedBy(ownerId: string): RepoRecord[];
  updateRepoSettings(id: string, settings: RepoSettings, at: number): RepoRecord;
  setRepoVisibility(id: string, visibility: Visibility, at: number): RepoRecord;
  transferRepo(id: string, newOwnerId: string, at: number): RepoRecord;
  /** Deletes the repository with its refs, labels and collaborators. */
  deleteRepo(id: string, at: number): void;

  setRef(repoId: string, name: string, sha: string, at: number): "created" | "updated";
  listRefs(repoId: string): Ref[];
  saveLabel(repoId: string, name: string, color: string, at: number): "created" | "updated";
  listLabels(repoId: string): Label[];

  addCollaborator(collaborator: CollaboratorRecord): void;
  getCollaborator(repoId: string, userId: string): CollaboratorRecord | undefined;
  listCollaborators(repoId: string): CollaboratorRecord[];
  changeCollaboratorRole(
    repoId: string,
    userId: string,
    role: CollaboratorRole,
    changedBy: string,
    at: number,
  ): CollaboratorRecord;
}
