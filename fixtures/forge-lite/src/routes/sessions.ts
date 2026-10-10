import { Hono } from "hono";
import { requireUser } from "../auth/authenticate.ts";
import { login, logout } from "../auth/sessions.ts";
import { readJsonObject, requiredString } from "../http/body.ts";
import type { AppEnv } from "../http/env.ts";
import { invalidCredentials } from "../http/problem.ts";
import { sessionView, userView } from "../http/views.ts";

export const sessionRoutes = new Hono<AppEnv>()
  .post("/sessions", async (c) => {
    const body = await readJsonObject(c);
    const issued = await login(c.var.deps, requiredString(body, "username"), requiredString(body, "password"));
    if (issued === undefined) throw invalidCredentials();
    return c.json(
      { token: issued.token, session: sessionView(issued.session), user: userView(issued.user) },
      201,
    );
  })

  .get("/sessions/current", (c) => c.json(sessionView(requireUser(c).session)))

  .delete("/sessions/current", (c) => {
    logout(c.var.deps, requireUser(c).session);
    return c.body(null, 204);
  });
