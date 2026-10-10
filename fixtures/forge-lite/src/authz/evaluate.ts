import type { Role } from "../domain/roles.ts";
import type { RepoRecord, Store } from "../store/types.ts";

/** The role `userId` holds on `repo`: owner, a collaborator role, or null for none. */
export function evaluateRole(store: Store, repo: RepoRecord, userId: string): Role | null {
  if (repo.ownerId === userId) return "owner";
  return store.getCollaborator(repo.id, userId)?.role ?? null;
}
