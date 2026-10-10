import { Hono, type Context } from "hono";
import { requireUser } from "../auth/authenticate.ts";
import { evaluateRole } from "../authz/evaluate.ts";
import { requirePermission } from "../authz/require-permission.ts";
import {
  MAX_DESCRIPTION_LENGTH,
  checkBranch,
  checkColor,
  checkLabel,
  checkRepoName,
  checkSha,
} from "../domain/names.ts";
import { isVisibility } from "../domain/visibility.ts";
import { check, optionalString, readJsonObject, requiredString } from "../http/body.ts";
import type { AppEnv } from "../http/env.ts";
import { conflict, validationFailed } from "../http/problem.ts";
import { repoView, type RepoView } from "../http/views.ts";
import type { RepoRecord, RepoSettings } from "../store/types.ts";

const DEFAULT_LABEL_COLOR = "ededed";

export const repoRoutes = new Hono<AppEnv>()
  .post("/repos", async (c) => {
    const { store, clock, ids } = c.var.deps;
    const { user } = requireUser(c);
    const body = await readJsonObject(c);
    const name = requiredString(body, "name");
    check(checkRepoName(name));
    const description = optionalString(body, "description") ?? "";
    checkDescription(description);
    const visibility = body["visibility"] ?? "private";
    if (!isVisibility(visibility)) throw validationFailed("visibility must be 'public' or 'private'");

    if (store.findRepo(user.id, name) !== undefined) {
      throw conflict("repo-exists", `repository ${user.username}/${name} already exists`);
    }
    const now = clock.now();
    const repo: RepoRecord = {
      id: ids.id("repo"),
      ownerId: user.id,
      name,
      description,
      visibility,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    };
    store.createRepo(repo);
    return c.json(repoView(repo, user, "owner"), 201, { location: `/repos/${user.username}/${name}` });
  })

  .get("/repos/:owner/:repo", requirePermission("read"), (c) => c.json(view(c, c.var.repo)))

  .patch("/repos/:owner/:repo", requirePermission("manage-settings"), async (c) => {
    const body = await readJsonObject(c);
    const description = optionalString(body, "description");
    const defaultBranch = optionalString(body, "defaultBranch");
    if (description === undefined && defaultBranch === undefined) {
      throw validationFailed("nothing to update: send description and/or defaultBranch");
    }
    if (description !== undefined) checkDescription(description);
    if (defaultBranch !== undefined) check(checkBranch(defaultBranch));
    const settings: RepoSettings = {
      ...(description === undefined ? {} : { description }),
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
    };
    const { store, clock } = c.var.deps;
    return c.json(view(c, store.updateRepoSettings(c.var.repo.id, settings, clock.now())));
  })

  .put("/repos/:owner/:repo/visibility", requirePermission("change-visibility"), async (c) => {
    const visibility = (await readJsonObject(c))["visibility"];
    if (!isVisibility(visibility)) throw validationFailed("visibility must be 'public' or 'private'");
    const { store, clock } = c.var.deps;
    const repo = c.var.repo;
    if (repo.visibility === visibility) return c.json(view(c, repo));
    return c.json(view(c, store.setRepoVisibility(repo.id, visibility, clock.now())));
  })

  .post("/repos/:owner/:repo/transfer", requirePermission("transfer"), async (c) => {
    const { store, clock } = c.var.deps;
    const { user } = requireUser(c);
    const newOwnerName = requiredString(await readJsonObject(c), "newOwner");
    const repo = c.var.repo;
    const newOwner = store.findUserByUsername(newOwnerName);
    if (newOwner === undefined) throw validationFailed(`newOwner ${newOwnerName} does not exist`);
    if (newOwner.id === repo.ownerId) throw validationFailed(`${newOwnerName} already owns this repository`);
    if (store.findRepo(newOwner.id, repo.name) !== undefined) {
      throw conflict("repo-exists", `repository ${newOwnerName}/${repo.name} already exists`);
    }
    const moved = store.transferRepo(repo.id, newOwner.id, clock.now());
    return c.json(repoView(moved, newOwner, evaluateRole(store, moved, user.id)));
  })

  .delete("/repos/:owner/:repo", requirePermission("delete-repo"), (c) => {
    const { store, clock } = c.var.deps;
    store.deleteRepo(c.var.repo.id, clock.now());
    return c.body(null, 204);
  })

  .get("/repos/:owner/:repo/refs", requirePermission("read"), (c) =>
    c.json(c.var.deps.store.listRefs(c.var.repo.id)),
  )

  .put("/repos/:owner/:repo/refs/heads/:branch", requirePermission("push"), async (c) => {
    const branch = c.req.param("branch");
    check(checkBranch(branch));
    const sha = requiredString(await readJsonObject(c), "sha");
    check(checkSha(sha));
    const { store, clock } = c.var.deps;
    const result = store.setRef(c.var.repo.id, branch, sha, clock.now());
    return c.json({ name: `refs/heads/${branch}`, sha }, result === "created" ? 201 : 200);
  })

  .get("/repos/:owner/:repo/labels", requirePermission("read"), (c) =>
    c.json(c.var.deps.store.listLabels(c.var.repo.id)),
  )

  .put("/repos/:owner/:repo/labels/:label", requirePermission("manage-issues"), async (c) => {
    const name = c.req.param("label");
    check(checkLabel(name));
    const color = optionalString(await readJsonObject(c), "color") ?? DEFAULT_LABEL_COLOR;
    check(checkColor(color));
    const { store, clock } = c.var.deps;
    const result = store.saveLabel(c.var.repo.id, name, color, clock.now());
    return c.json({ name, color }, result === "created" ? 201 : 200);
  });

function checkDescription(description: string): void {
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw validationFailed(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
}

/** The repository as the caller sees it, with their role from requirePermission. */
function view(c: Context<AppEnv>, repo: RepoRecord): RepoView {
  const owner = c.var.deps.store.getUser(repo.ownerId);
  if (owner === undefined) throw new Error(`repository ${repo.id} has no owner`);
  return repoView(repo, owner, c.var.role);
}
