// The console's Worker. It serves the built page, answers its own health
// check, and hands on to Keel what is Keel's to answer.
//
//   GET  /healthz
//   GET  /<namespace>/<project>.git/info/refs
//   POST /<namespace>/<project>.git/git-upload-pack    Keel's, as they came
//   any  /<namespace>/<project>.git/git-receive-pack
//   any  /v1/*  /mcp  /mcp/*  /start  /llms.txt  /.well-known/*    Keel's, as they came
//   any  /admin  /admin/*  /sitemap.xml  …     404, with the built page
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

import type { ReservedSegment } from "../contract/keel/index.ts";

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

/**
 * Who answers each first segment Keel reserves, on this site: a page of the console's, Keel's Worker, this
 * Worker, a file of the build, or nobody. Typed by Keel's own list, so a word Keel adds is placed here before
 * the console builds. `rule` was the retired ruling page's path: the build guard keeps it out of this Worker's
 * config, so the page itself draws it as not found.
 */
const ANSWERS: Record<ReservedSegment, "page" | "keel" | "worker" | "file" | "nobody" | "retired"> =
  {
    api: "nobody",
    v1: "keel",
    mcp: "keel",
    auth: "nobody",
    assets: "file",
    healthz: "worker",
    login: "page",
    signup: "page",
    logout: "nobody",
    device: "page",
    invite: "page",
    sponsor: "page",
    settings: "page",
    new: "page",
    orgs: "page",
    install: "nobody",
    admin: "nobody",
    terms: "page",
    privacy: "page",
    rule: "retired",
    start: "keel",
    "llms.txt": "keel",
    ".well-known": "keel",
    "robots.txt": "file",
    "favicon.ico": "nobody",
  };

/** The reserved first segments nothing on this site answers: each, and everything under it, is not found. */
export const NOWHERE: readonly string[] = Object.entries(ANSWERS)
  .filter(([, who]) => who === "nobody")
  .map(([segment]) => segment);

/**
 * Whether nothing here answers a path: one under a first segment nobody has, or a sitemap, which this site has
 * none of. Keel's own pages are found by its catalogue and `/llms.txt`, and a project's by its namespace's page.
 */
function nowhere(pathname: string): boolean {
  return pathname === "/sitemap.xml" || NOWHERE.includes(pathname.split("/")[1] ?? "");
}

export interface Console {
  fetch(request: Request, env: Env): Promise<Response>;
}

export function createConsole(): Console {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz") return Response.json({ ok: true, service: "keel-console" });
      if (GIT.test(pathname) || KEELS.test(pathname)) return env.KEEL.fetch(request);
      if (nowhere(pathname)) {
        // The built page draws its own not-found; the answer says so too, to whoever reads only its status.
        const page = await env.ASSETS.fetch(new Request(new URL("/", request.url)));
        return new Response(page.body, {
          status: 404,
          headers: {
            "content-type": page.headers.get("content-type") ?? "text/html; charset=utf-8",
          },
        });
      }
      return env.ASSETS.fetch(request);
    },
  };
}
