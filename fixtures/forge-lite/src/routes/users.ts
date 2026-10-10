import { Hono } from "hono";
import { requireUser } from "../auth/authenticate.ts";
import { hashPassword } from "../auth/passwords.ts";
import { evaluateRole } from "../authz/evaluate.ts";
import { MAX_DISPLAY_NAME_LENGTH, checkPassword, checkUsername } from "../domain/names.ts";
import { canSee } from "../domain/permissions.ts";
import { check, optionalString, readJsonObject, requiredString } from "../http/body.ts";
import type { AppEnv } from "../http/env.ts";
import { conflict, notFound, validationFailed } from "../http/problem.ts";
import { repoView, userView } from "../http/views.ts";
import type { UserRecord } from "../store/types.ts";

export const userRoutes = new Hono<AppEnv>()
  .post("/users", async (c) => {
    const { store, clock, ids } = c.var.deps;
    const body = await readJsonObject(c);
    const username = requiredString(body, "username");
    check(checkUsername(username));
    const password = requiredString(body, "password");
    check(checkPassword(password));
    const name = optionalString(body, "name") ?? username;
    if (name.length > MAX_DISPLAY_NAME_LENGTH) {
      throw validationFailed(`name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`);
    }

    const salt = ids.secret();
    const passwordHash = await hashPassword(password, salt);
    // Checked after the last await, so a concurrent sign-up cannot slip in between.
    if (store.findUserByUsername(username) !== undefined) {
      throw conflict("username-taken", `username ${username} is already taken`);
    }
    const user: UserRecord = {
      id: ids.id("usr"),
      username,
      name,
      passwordSalt: salt,
      passwordHash,
      createdAt: clock.now(),
    };
    store.createUser(user);
    return c.json(userView(user), 201, { location: `/users/${username}` });
  })

  .get("/user", (c) => c.json(userView(requireUser(c).user)))

  .get("/users/:username", (c) => {
    const user = c.var.deps.store.findUserByUsername(c.req.param("username"));
    if (user === undefined) throw notFound(`user ${c.req.param("username")} not found`);
    return c.json(userView(user));
  })

  .get("/users/:username/repos", (c) => {
    const { store } = c.var.deps;
    const owner = store.findUserByUsername(c.req.param("username"));
    if (owner === undefined) throw notFound(`user ${c.req.param("username")} not found`);
    const viewer = c.var.user;
    const visible = store
      .listReposOwnedBy(owner.id)
      .map((repo) => ({ repo, role: viewer === undefined ? null : evaluateRole(store, repo, viewer.id) }))
      .filter(({ repo, role }) => canSee(role, repo.visibility))
      .map(({ repo, role }) => repoView(repo, owner, role));
    return c.json(visible);
  });
