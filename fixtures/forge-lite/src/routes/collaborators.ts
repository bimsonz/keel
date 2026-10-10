import { Hono, type Context } from "hono";
import { requireUser } from "../auth/authenticate.ts";
import { requirePermission } from "../authz/require-permission.ts";
import { COLLABORATOR_ROLES, compareRoles, isCollaboratorRole, type CollaboratorRole } from "../domain/roles.ts";
import { readJsonObject } from "../http/body.ts";
import type { AppEnv } from "../http/env.ts";
import { conflict, notFound, validationFailed } from "../http/problem.ts";
import { collaboratorView } from "../http/views.ts";
import type { CollaboratorRecord, UserRecord } from "../store/types.ts";

export const collaboratorRoutes = new Hono<AppEnv>()
  .get("/repos/:owner/:repo/collaborators", requirePermission("read"), (c) => {
    const { store } = c.var.deps;
    const listed = store
      .listCollaborators(c.var.repo.id)
      .flatMap((collaborator) => {
        const user = store.getUser(collaborator.userId);
        return user === undefined ? [] : [collaboratorView(collaborator, user)];
      })
      .toSorted((a, b) => a.username.localeCompare(b.username));
    return c.json(listed);
  })

  .put("/repos/:owner/:repo/collaborators/:username", requirePermission("add-collaborator"), async (c) => {
    const { store, clock } = c.var.deps;
    const { user: actor } = requireUser(c);
    const role = await readRole(c);
    const repo = c.var.repo;
    const target = targetUser(c);
    if (target.id === repo.ownerId) throw validationFailed("the owner cannot be added as a collaborator");
    if (store.getCollaborator(repo.id, target.id) !== undefined) {
      throw conflict(
        "already-collaborator",
        `${target.username} already collaborates on this repository; use PATCH to change their role`,
      );
    }
    const collaborator: CollaboratorRecord = {
      repoId: repo.id,
      userId: target.id,
      role,
      addedBy: actor.id,
      addedAt: clock.now(),
    };
    store.addCollaborator(collaborator);
    return c.json(collaboratorView(collaborator, target), 201);
  })

  .patch("/repos/:owner/:repo/collaborators/:username", requirePermission("change-role"), async (c) => {
    const { store, clock } = c.var.deps;
    const { user: actor } = requireUser(c);
    const role = await readRole(c);
    const repo = c.var.repo;
    const target = targetUser(c);
    const current = store.getCollaborator(repo.id, target.id);
    if (current === undefined) throw notFound(`${target.username} is not a collaborator on this repository`);
    // Access only ever grows: there is no way to lower a role or take one away.
    if (compareRoles(role, current.role) < 0) {
      throw conflict(
        "role-downgrade",
        `roles can only be raised; ${target.username} holds ${current.role}, which is above ${role}`,
      );
    }
    if (role === current.role) return c.json(collaboratorView(current, target));
    const updated = store.changeCollaboratorRole(repo.id, target.id, role, actor.id, clock.now());
    return c.json(collaboratorView(updated, target));
  });

async function readRole(c: Context<AppEnv>): Promise<CollaboratorRole> {
  const role = (await readJsonObject(c))["role"];
  if (!isCollaboratorRole(role)) throw validationFailed(`role must be one of ${COLLABORATOR_ROLES.join(", ")}`);
  return role;
}

function targetUser(c: Context<AppEnv>): UserRecord {
  const username = c.req.param("username") ?? "";
  const user = c.var.deps.store.findUserByUsername(username);
  if (user === undefined) throw notFound(`user ${username} not found`);
  return user;
}
