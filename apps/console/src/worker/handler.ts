// The console's Worker. It serves the built page, answers its own health
// check, and hands a git client's fetch of a project on to Keel.
//
//   GET  /healthz
//   GET  /<namespace>/<project>.git/info/refs
//   POST /<namespace>/<project>.git/git-upload-pack    Keel's, as they came
//   any  /<namespace>/<project>.git/git-receive-pack
//   anything else   the built page
//
// The page reads Keel itself, on its own origin under /v1, as whoever is
// signed in: the session is a cookie Keel set, which the browser sends and no
// script can read. So this Worker holds no credential and reads nothing of
// Keel for anyone. A clone address is the one thing it passes on, because no
// route can name it (a route's wildcard is only ever its tail): the request
// goes to Keel untouched, nothing is added to it, and Keel decides it as it
// decides a request from anywhere.

/** Something that answers requests: the assets binding. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** The built page. */
  ASSETS: Fetcher;
  /** Keel's Worker, for a clone address and nothing else. */
  KEEL: Fetcher;
}

/**
 * A clone address's three git paths, `/<namespace>/<project>.git/` and what
 * git's smart HTTP asks under it. Nothing shorter, longer or deeper is one:
 * every other path under a project is a place in the page.
 */
const GIT = /^\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

export interface Console {
  fetch(request: Request, env: Env): Promise<Response>;
}

export function createConsole(): Console {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz") return Response.json({ ok: true, service: "keel-console" });
      if (GIT.test(pathname)) return env.KEEL.fetch(request);
      return env.ASSETS.fetch(request);
    },
  };
}
