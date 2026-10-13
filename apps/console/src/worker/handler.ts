// The console's Worker. It serves the built page, answers its own health
// check, and hands on to Keel what is Keel's to answer.
//
//   GET  /healthz
//   GET  /<namespace>/<project>.git/info/refs
//   POST /<namespace>/<project>.git/git-upload-pack    Keel's, as they came
//   any  /<namespace>/<project>.git/git-receive-pack
//   any  /v1/*  /mcp  /mcp/*  /start  /llms.txt  /.well-known/*    Keel's, as they came
//   anything else   the built page
//
// The page reads Keel itself, on its own origin under /v1, as whoever is
// signed in: the session is a cookie Keel set, which the browser sends and no
// script can read. So this Worker holds no credential and reads nothing of
// Keel for anyone. What it passes on goes to Keel untouched: nothing is added
// to the request, and Keel decides it as it decides a request from anywhere.
//
// A clone address is passed on everywhere, because no route can name it (a
// route's wildcard is only ever its tail). Keel's own paths are passed on
// where the site has no routes to put Keel in front of them: a site on a
// workers.dev address has no zone, so this Worker is its only door. Where the
// routes exist they take those paths first, and this Worker never sees them.

/** Something that answers requests: the assets binding. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** The built page. */
  ASSETS: Fetcher;
  /** Keel's Worker, for a clone address and Keel's own paths, and nothing else. */
  KEEL: Fetcher;
}

/**
 * A clone address's three git paths, `/<namespace>/<project>.git/` and what
 * git's smart HTTP asks under it. Nothing shorter, longer or deeper is one:
 * every other path under a project is a place in the page.
 */
const GIT = /^\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Keel's own paths, the ones a site's routes name: everything under `/v1/`,
 * `/mcp/` and `/.well-known/`, and `/mcp`, `/start` and `/llms.txt` exactly.
 * A handle that only begins with one of those words (`/starter`, `/mcpx`,
 * `/v1`) is a place in the page.
 */
const KEELS = /^\/(?:v1\/|mcp\/|\.well-known\/|(?:mcp|start|llms\.txt)$)/;

export interface Console {
  fetch(request: Request, env: Env): Promise<Response>;
}

export function createConsole(): Console {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz") return Response.json({ ok: true, service: "keel-console" });
      if (GIT.test(pathname) || KEELS.test(pathname)) return env.KEEL.fetch(request);
      return env.ASSETS.fetch(request);
    },
  };
}
