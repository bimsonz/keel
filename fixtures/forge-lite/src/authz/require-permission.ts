import type { Context, MiddlewareHandler } from "hono";
import { allows, canSee, minimumRole, type Action } from "../domain/permissions.ts";
import type { Role } from "../domain/roles.ts";
import type { AppEnv } from "../http/env.ts";
import { forbidden, notFound, unauthenticated, type Problem } from "../http/problem.ts";
import type { RepoRecord } from "../store/types.ts";
import { evaluateRole } from "./evaluate.ts";

/**
 * Guards a route under `/repos/:owner/:repo`. It loads the repository,
 * evaluates the caller's role on it, and lets the request through only if
 * that role allows `action`. On success the handler finds `repo` and `role`
 * on the context.
 *
 * The role is read from the store on every request, so a change to someone's
 * access applies from their very next request.
 *
 * A caller who cannot see the repository gets 404, exactly as if it did not
 * exist. A caller who can see it but may not act gets 403, or 401 when they
 * are not signed in.
 */
export function requirePermission(action: Action): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const repo = loadRepo(c);
    const role = callerRole(c, repo);
    if (!allows(role, action, repo.visibility)) throw denial(c, repo, role, action);
    c.set("repo", repo);
    c.set("role", role);
    await next();
  };
}

function callerRole(c: Context<AppEnv>, repo: RepoRecord): Role | null {
  const { user } = c.var;
  if (user === undefined) return null;
  return evaluateRole(c.var.deps.store, repo, user.id);
}

function loadRepo(c: Context<AppEnv>): RepoRecord {
  const { store } = c.var.deps;
  const owner = store.findUserByUsername(c.req.param("owner") ?? "");
  const repo = owner === undefined ? undefined : store.findRepo(owner.id, c.req.param("repo") ?? "");
  if (repo === undefined) throw notFound(`repository ${path(c)} not found`);
  return repo;
}

function denial(c: Context<AppEnv>, repo: RepoRecord, role: Role | null, action: Action): Problem {
  if (!canSee(role, repo.visibility)) return notFound(`repository ${path(c)} not found`);
  if (c.var.user === undefined) return unauthenticated(`${action} on ${path(c)} requires a bearer token`);
  return forbidden(`${action} on ${path(c)} requires the ${minimumRole(action)} role`);
}

function path(c: Context<AppEnv>): string {
  return `${c.req.param("owner") ?? ""}/${c.req.param("repo") ?? ""}`;
}
