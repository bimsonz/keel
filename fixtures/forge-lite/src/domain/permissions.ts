import { atLeast, type Role } from "./roles.ts";
import type { Visibility } from "./visibility.ts";

/** Everything a caller can ask to do to a repository. */
export const ACTIONS = [
  "read",
  "manage-issues",
  "push",
  "manage-settings",
  "change-visibility",
  "add-collaborator",
  "change-role",
  "delete-repo",
  "transfer",
] as const;

export type Action = (typeof ACTIONS)[number];

const MINIMUM_ROLE: Readonly<Record<Action, Role>> = {
  read: "read",
  "manage-issues": "triage",
  push: "write",
  "manage-settings": "maintain",
  "change-visibility": "admin",
  "add-collaborator": "admin",
  "change-role": "admin",
  "delete-repo": "admin",
  transfer: "owner",
};

/** The lowest role that may perform `action`. */
export function minimumRole(action: Action): Role {
  return MINIMUM_ROLE[action];
}

/**
 * Whether a caller holding `role` (null for no role at all) may perform
 * `action` on a repository with the given visibility. Anyone may read a
 * public repository; everything else needs a role.
 */
export function allows(role: Role | null, action: Action, visibility: Visibility): boolean {
  if (action === "read" && visibility === "public") return true;
  return role !== null && atLeast(role, MINIMUM_ROLE[action]);
}

/** Whether a caller holding `role` can see that the repository exists at all. */
export function canSee(role: Role | null, visibility: Visibility): boolean {
  return visibility === "public" || role !== null;
}
