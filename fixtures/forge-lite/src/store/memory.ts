import type { CollaboratorRole } from "../domain/roles.ts";
import type { Visibility } from "../domain/visibility.ts";
import { EventBus } from "../events.ts";
import type {
  CollaboratorRecord,
  Label,
  Ref,
  RepoRecord,
  RepoSettings,
  SessionRecord,
  Store,
  UserRecord,
} from "./types.ts";

/**
 * An in-memory store. One instance holds one forge's worth of state; nothing
 * is shared between instances.
 */
export class MemoryStore implements Store {
  readonly events: EventBus;

  readonly #users = new Map<string, UserRecord>();
  readonly #userIdsByName = new Map<string, string>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #sessionIdsByTokenHash = new Map<string, string>();
  readonly #repos = new Map<string, RepoRecord>();
  readonly #refs = new Map<string, Map<string, string>>();
  readonly #labels = new Map<string, Map<string, string>>();
  readonly #collaborators = new Map<string, Map<string, CollaboratorRecord>>();

  constructor(events: EventBus = new EventBus()) {
    this.events = events;
  }

  // Users

  createUser(user: UserRecord): void {
    if (this.#userIdsByName.has(user.username)) {
      throw new Error(`username ${user.username} is already taken`);
    }
    this.#users.set(user.id, user);
    this.#userIdsByName.set(user.username, user.id);
    this.events.emit({ type: "user.created", at: user.createdAt, userId: user.id, username: user.username });
  }

  getUser(id: string): UserRecord | undefined {
    return this.#users.get(id);
  }

  findUserByUsername(username: string): UserRecord | undefined {
    const id = this.#userIdsByName.get(username);
    return id === undefined ? undefined : this.#users.get(id);
  }

  // Sessions

  createSession(session: SessionRecord): void {
    this.#sessions.set(session.id, session);
    this.#sessionIdsByTokenHash.set(session.tokenHash, session.id);
    this.events.emit({
      type: "session.created",
      at: session.createdAt,
      sessionId: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
    });
  }

  findSessionByTokenHash(tokenHash: string): SessionRecord | undefined {
    const id = this.#sessionIdsByTokenHash.get(tokenHash);
    return id === undefined ? undefined : this.#sessions.get(id);
  }

  deleteSession(id: string, at: number): void {
    const session = this.#require(this.#sessions, id, "session");
    this.#sessions.delete(id);
    this.#sessionIdsByTokenHash.delete(session.tokenHash);
    this.events.emit({ type: "session.ended", at, sessionId: id, userId: session.userId });
  }

  // Repositories

  createRepo(repo: RepoRecord): void {
    if (this.findRepo(repo.ownerId, repo.name)) {
      throw new Error(`repository ${repo.name} already exists for ${repo.ownerId}`);
    }
    this.#repos.set(repo.id, repo);
    this.events.emit({
      type: "repo.created",
      at: repo.createdAt,
      repoId: repo.id,
      ownerId: repo.ownerId,
      name: repo.name,
      visibility: repo.visibility,
    });
  }

  getRepo(id: string): RepoRecord | undefined {
    return this.#repos.get(id);
  }

  findRepo(ownerId: string, name: string): RepoRecord | undefined {
    for (const repo of this.#repos.values()) {
      if (repo.ownerId === ownerId && repo.name === name) return repo;
    }
    return undefined;
  }

  listReposOwnedBy(ownerId: string): RepoRecord[] {
    return [...this.#repos.values()]
      .filter((repo) => repo.ownerId === ownerId)
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  updateRepoSettings(id: string, settings: RepoSettings, at: number): RepoRecord {
    const repo = this.#require(this.#repos, id, "repository");
    const updated: RepoRecord = {
      ...repo,
      description: settings.description ?? repo.description,
      defaultBranch: settings.defaultBranch ?? repo.defaultBranch,
      updatedAt: at,
    };
    this.#repos.set(id, updated);
    this.events.emit({ type: "repo.updated", at, repoId: id, fields: Object.keys(settings).toSorted() });
    return updated;
  }

  setRepoVisibility(id: string, visibility: Visibility, at: number): RepoRecord {
    const repo = this.#require(this.#repos, id, "repository");
    const updated: RepoRecord = { ...repo, visibility, updatedAt: at };
    this.#repos.set(id, updated);
    this.events.emit({ type: "repo.visibility-changed", at, repoId: id, from: repo.visibility, to: visibility });
    return updated;
  }

  transferRepo(id: string, newOwnerId: string, at: number): RepoRecord {
    const repo = this.#require(this.#repos, id, "repository");
    if (this.findRepo(newOwnerId, repo.name)) {
      throw new Error(`repository ${repo.name} already exists for ${newOwnerId}`);
    }
    const updated: RepoRecord = { ...repo, ownerId: newOwnerId, updatedAt: at };
    this.#repos.set(id, updated);
    this.events.emit({ type: "repo.transferred", at, repoId: id, fromOwnerId: repo.ownerId, toOwnerId: newOwnerId });
    return updated;
  }

  deleteRepo(id: string, at: number): void {
    const repo = this.#require(this.#repos, id, "repository");
    this.#repos.delete(id);
    this.#refs.delete(id);
    this.#labels.delete(id);
    this.#collaborators.delete(id);
    this.events.emit({ type: "repo.deleted", at, repoId: id, ownerId: repo.ownerId, name: repo.name });
  }

  // Refs and labels

  setRef(repoId: string, name: string, sha: string, at: number): "created" | "updated" {
    this.#require(this.#repos, repoId, "repository");
    const refs = this.#bucket(this.#refs, repoId);
    const ref = `refs/heads/${name}`;
    const previous = refs.get(ref);
    refs.set(ref, sha);
    this.events.emit({ type: "ref.updated", at, repoId, ref, from: previous ?? null, to: sha });
    return previous === undefined ? "created" : "updated";
  }

  listRefs(repoId: string): Ref[] {
    const refs = this.#refs.get(repoId) ?? new Map<string, string>();
    return [...refs]
      .map(([name, sha]) => ({ name, sha }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  saveLabel(repoId: string, name: string, color: string, at: number): "created" | "updated" {
    this.#require(this.#repos, repoId, "repository");
    const labels = this.#bucket(this.#labels, repoId);
    const existed = labels.has(name);
    labels.set(name, color);
    this.events.emit({ type: "label.saved", at, repoId, name, color });
    return existed ? "updated" : "created";
  }

  listLabels(repoId: string): Label[] {
    const labels = this.#labels.get(repoId) ?? new Map<string, string>();
    return [...labels]
      .map(([name, color]) => ({ name, color }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  // Collaborators

  addCollaborator(collaborator: CollaboratorRecord): void {
    this.#require(this.#repos, collaborator.repoId, "repository");
    const collaborators = this.#bucket(this.#collaborators, collaborator.repoId);
    if (collaborators.has(collaborator.userId)) {
      throw new Error(`${collaborator.userId} already collaborates on ${collaborator.repoId}`);
    }
    collaborators.set(collaborator.userId, collaborator);
    this.events.emit({
      type: "collaborator.added",
      at: collaborator.addedAt,
      repoId: collaborator.repoId,
      userId: collaborator.userId,
      role: collaborator.role,
      addedBy: collaborator.addedBy,
    });
  }

  getCollaborator(repoId: string, userId: string): CollaboratorRecord | undefined {
    return this.#collaborators.get(repoId)?.get(userId);
  }

  listCollaborators(repoId: string): CollaboratorRecord[] {
    return [...(this.#collaborators.get(repoId)?.values() ?? [])];
  }

  changeCollaboratorRole(
    repoId: string,
    userId: string,
    role: CollaboratorRole,
    changedBy: string,
    at: number,
  ): CollaboratorRecord {
    const collaborators = this.#bucket(this.#collaborators, repoId);
    const current = this.#require(collaborators, userId, "collaborator");
    const updated: CollaboratorRecord = { ...current, role };
    collaborators.set(userId, updated);
    this.events.emit({
      type: "collaborator.role-changed",
      at,
      repoId,
      userId,
      from: current.role,
      to: role,
      changedBy,
    });
    return updated;
  }

  // Helpers

  #require<V>(map: Map<string, V>, key: string, what: string): V {
    const value = map.get(key);
    if (value === undefined) throw new Error(`unknown ${what} ${key}`);
    return value;
  }

  #bucket<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
    let bucket = map.get(key);
    if (bucket === undefined) {
      bucket = new Map<string, V>();
      map.set(key, bucket);
    }
    return bucket;
  }
}
