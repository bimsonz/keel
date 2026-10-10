import { Hono } from "hono";
import { authenticate } from "./auth/authenticate.ts";
import type { Deps } from "./deps.ts";
import type { AppEnv } from "./http/env.ts";
import { handleError } from "./http/problem.ts";
import { collaboratorRoutes } from "./routes/collaborators.ts";
import { repoRoutes } from "./routes/repos.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { userRoutes } from "./routes/users.ts";

/**
 * Builds the forge-lite API around the given dependencies. Each call returns
 * an independent app: all state lives in `deps.store`.
 *
 * Errors from handlers are problem+json. Requests that match no route fall
 * through to Hono's default 404 ("404 Not Found", text/plain), which keeps
 * "this route does not exist" distinguishable from "this resource does not
 * exist".
 */
export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use(authenticate());
  app.route("/", userRoutes);
  app.route("/", sessionRoutes);
  app.route("/", repoRoutes);
  app.route("/", collaboratorRoutes);
  app.onError(handleError);
  return app;
}
