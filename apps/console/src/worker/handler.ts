// The console's Worker. It serves the built page and answers its own health
// check, and that is all of it.
//
//   GET  /healthz
//   anything else   the built page
//
// The page reads Keel itself, on its own origin under /v1, as whoever is
// signed in: the session is a cookie Keel set, which the browser sends and no
// script can read. So this Worker holds no credential, is bound to nothing but
// its own files, and passes nothing on to Keel.

/** Something that answers requests: the assets binding. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** The built page. */
  ASSETS: Fetcher;
}

export interface Console {
  fetch(request: Request, env: Env): Promise<Response>;
}

export function createConsole(): Console {
  return {
    async fetch(request, env) {
      if (new URL(request.url).pathname === "/healthz")
        return Response.json({ ok: true, service: "keel-console" });
      return env.ASSETS.fetch(request);
    },
  };
}
