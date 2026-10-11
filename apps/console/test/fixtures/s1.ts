// The source text scenario 1 serves as resources: the probe Keel drafts, and
// the files of change B's diff.

export const PROBE_SOURCE = `// Probe P-1, drafted by Keel for conflict C-1.
// Contested: authz.permission-evaluation / freshness
//   A relies on: at most per-request
//   B alters it to: per-session
import { probe } from "keel:probe";

probe("a revoked collaborator is refused on the next request", async ({ app, precondition }) => {
  // n/a unless this world has a revocation path at all.
  precondition(app.has("collaborators.revoke"), "no revocation path in this world");

  const owner = await app.session("owner");
  const bob = await app.session("bob", { role: "collaborator" });

  // Bob's session is warm: he has already passed one permission check.
  await bob.request("GET", "/repos/demo/settings");

  await owner.request("DELETE", "/repos/demo/collaborators/bob");

  // The very next request must be refused.
  const after = await bob.request("DELETE", "/repos/demo");
  return after.status === 403;
});
`;

export const CHECK_BEFORE = `import { Forbidden, type Action } from "./actions.ts";
import { loadRoles } from "./roles.ts";
import type { Request } from "../http.ts";

export async function requirePermission(req: Request, action: Action): Promise<void> {
  const roles = await loadRoles(req.user.id, req.repo.id);
  if (!roles.some((role) => role.allows(action))) {
    throw new Forbidden(action);
  }
}
`;

export const CHECK_AFTER = `import { Forbidden, type Action } from "./actions.ts";
import { permissionCache } from "./cache.ts";
import type { Request } from "../http.ts";

export async function requirePermission(req: Request, action: Action): Promise<void> {
  const roles = await permissionCache.rolesFor(req.session, req.repo.id);
  if (!roles.some((role) => role.allows(action))) {
    throw new Forbidden(action);
  }
}
`;

export const CACHE_AFTER = `import { loadRoles, type Role } from "./roles.ts";
import type { Session } from "../http.ts";

/** Roles per session and repository. Filled on first use, kept until the session ends. */
class PermissionCache {
  readonly #bySession = new WeakMap<Session, Map<string, Role[]>>();

  async rolesFor(session: Session, repoId: string): Promise<Role[]> {
    let repos = this.#bySession.get(session);
    if (repos === undefined) {
      repos = new Map();
      this.#bySession.set(session, repos);
    }
    let roles = repos.get(repoId);
    if (roles === undefined) {
      roles = await loadRoles(session.userId, repoId);
      repos.set(repoId, roles);
    }
    return roles;
  }
}

export const permissionCache = new PermissionCache();
`;
