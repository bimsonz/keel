import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ProjectView } from "../../../src/contract/keel/index.ts";
import { readCache } from "../../../src/source/cache.ts";
import { createHttpSource } from "../../../src/source/http.ts";
import type { KeptPage, LogPages } from "../../../src/source/log-pages.ts";
import { prefetchAddress } from "../../../src/source/prefetch.ts";

const ORIGIN = "https://keel.example";
const SHA = "a".repeat(40);

const projectOf = (visibility: "public" | "private"): ProjectView => ({
  id: "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0",
  namespace: { handle: "acme", kind: "org" },
  name: "demo",
  visibility,
  createdAt: "2026-10-15T00:00:00.000Z",
});

/** A record of the log, as Keel publishes one. */
const record = (n: number) => ({
  eventId: `evt_${String(n).padStart(26, "0")}`,
  type: "ProjectCreated",
  entity: { kind: "project", id: "prj_01JZ8PT2C4E6G8J0M2N4Q6S8V0" },
  seq: n,
  at: "2026-10-15T00:00:00.000Z",
  payload: { _tag: "ProjectCreated" },
});

/** A stand-in for Keel that counts what it is asked: a tree and a commit, a log of `logged` entries, and a missing file. */
function fakeKeel(logged = 5) {
  const asked: string[] = [];
  const fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ORIGIN,
    );
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/repo/tree"))
      return Promise.resolve(Response.json({ commit: SHA, path: "", entries: [] }));
    if (url.pathname.includes("/repo/commits/"))
      return Promise.resolve(Response.json({ commit: { sha: SHA }, files: [] }));
    if (url.pathname.endsWith("/repo/blob"))
      return Promise.resolve(Response.json({ code: "repo.path_not_found" }, { status: 404 }));
    if (url.pathname === "/v1/events") {
      const from = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "500");
      const items = Array.from({ length: Math.max(0, Math.min(limit, logged - from)) }, (_, i) =>
        record(from + i + 1),
      );
      return Promise.resolve(Response.json({ items, nextCursor: String(from + items.length) }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  };
  return { fetch, asked };
}

/** Log pages kept in memory, as the browser's would be. */
function memoryLogPages(): LogPages & { readonly kept: Map<string, KeptPage> } {
  const kept = new Map<string, KeptPage>();
  return {
    kept,
    get: (projectId, cursor) => Promise.resolve(kept.get(`${projectId} ${cursor}`)),
    put: (projectId, cursor, page) => {
      kept.set(`${projectId} ${cursor}`, page);
      return Promise.resolve();
    },
  };
}

describe("the console's read cache", () => {
  it("[cache.shared] reads asked for together are one read, a fresh answer is served from memory, and a commit is read once", async () => {
    const keel = fakeKeel();
    const source = createHttpSource(projectOf("public"), {
      origin: ORIGIN,
      fetch: keel.fetch,
      cache: new QueryClient(),
      logPages: null,
    });
    const id = projectOf("public").id;
    await Promise.all([source.getTree(id, { path: "" }), source.getTree(id, { path: "" })]);
    await source.getTree(id, { path: "" });
    await source.getCommit(id, SHA);
    await source.getCommit(id, SHA);
    expect(keel.asked.filter((path) => path.includes("/repo/tree"))).toHaveLength(1);
    expect(keel.asked.filter((path) => path.includes("/repo/commits/"))).toHaveLength(1);
  });

  it("[cache.refusal] a read Keel refused is not kept: the next to ask asks Keel again", async () => {
    const keel = fakeKeel();
    const source = createHttpSource(projectOf("public"), {
      origin: ORIGIN,
      fetch: keel.fetch,
      cache: new QueryClient(),
      logPages: null,
    });
    const id = projectOf("public").id;
    await expect(source.getBlob(id, { path: "README.md" })).rejects.toThrow(
      "Keel refused the read",
    );
    await expect(source.getBlob(id, { path: "README.md" })).rejects.toThrow(
      "Keel refused the read",
    );
    expect(keel.asked.filter((path) => path.includes("/repo/blob"))).toHaveLength(2);
  });

  it("[cache.abort] a reader who goes elsewhere is answered at once, and the read goes on for the next to ask", async () => {
    const keel = fakeKeel();
    const source = createHttpSource(projectOf("public"), {
      origin: ORIGIN,
      fetch: keel.fetch,
      cache: new QueryClient(),
      logPages: null,
    });
    const id = projectOf("public").id;
    const away = new AbortController();
    const first = source.getTree(id, { path: "src" }, away.signal);
    away.abort();
    await expect(first).rejects.toBeDefined();
    await source.getTree(id, { path: "src" });
    expect(keel.asked.filter((path) => path.includes("/repo/tree"))).toHaveLength(1);
  });

  it("[cache.none] a source given its own fetch and no cache asks Keel every time", async () => {
    const keel = fakeKeel();
    const source = createHttpSource(projectOf("public"), { origin: ORIGIN, fetch: keel.fetch });
    const id = projectOf("public").id;
    await source.getTree(id, { path: "" });
    await source.getTree(id, { path: "" });
    expect(keel.asked.filter((path) => path.includes("/repo/tree"))).toHaveLength(2);
  });
});

describe("a public project's kept log pages", () => {
  it("[log-pages.full] a full page is kept and folded again from the browser; a short one, a waited one and a private project's are not", async () => {
    const keel = fakeKeel(3);
    const pages = memoryLogPages();
    const source = createHttpSource(projectOf("public"), {
      origin: ORIGIN,
      fetch: keel.fetch,
      cache: null,
      logPages: pages,
    });
    const full = await source.readEvents({ limit: 2 });
    const again = await source.readEvents({ limit: 2 });
    expect(again).toEqual(full);
    expect(keel.asked.filter((path) => path.startsWith("/v1/events"))).toHaveLength(1);
    // The rest of the log is one entry: a short page, the log's end for now, and read from Keel every time.
    await source.readEvents({ limit: 2, cursor: full.nextCursor });
    await source.readEvents({ limit: 2, cursor: full.nextCursor });
    await source.readEvents({ limit: 2, cursor: full.nextCursor, waitSec: 1 });
    expect(keel.asked.filter((path) => path.startsWith("/v1/events"))).toHaveLength(4);
    expect([...pages.kept.keys()]).toEqual([`${projectOf("public").id} `]);

    const hidden = memoryLogPages();
    const own = createHttpSource(projectOf("private"), {
      origin: ORIGIN,
      fetch: keel.fetch,
      cache: null,
      logPages: hidden,
    });
    await own.readEvents({ limit: 2 });
    expect(hidden.kept.size).toBe(0);
  });
});

describe("prefetching a page's reads", () => {
  it("[prefetch.code] a code address asks for the project, the directory and those above it, its README and trunk's history, and the page's own reads then find them", async () => {
    readCache.clear();
    const asked: string[] = [];
    const serve = (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        ORIGIN,
      );
      asked.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/namespaces/acme/projects/demo")
        return Promise.resolve(Response.json(projectOf("public")));
      if (url.pathname.endsWith("/repo/tree"))
        return Promise.resolve(Response.json({ commit: SHA, path: "", entries: [] }));
      if (url.pathname.endsWith("/repo/blob"))
        return Promise.resolve(Response.json({ path: "x", content: "" }));
      if (url.pathname.endsWith("/repo/commits"))
        return Promise.resolve(Response.json({ items: [] }));
      return Promise.resolve(Response.json({}, { status: 404 }));
    };
    vi.stubGlobal("fetch", serve);
    try {
      await prefetchAddress("/acme/demo/tree/trunk/src/authz");
      expect(asked.toSorted()).toEqual(
        [
          "/v1/namespaces/acme/projects/demo",
          `/v1/projects/${projectOf("public").id}/repo/commits?limit=100`,
          `/v1/projects/${projectOf("public").id}/repo/tree?path=src%2Fauthz`,
          `/v1/projects/${projectOf("public").id}/repo/blob?path=src%2Fauthz%2FREADME.md`,
          `/v1/projects/${projectOf("public").id}/repo/tree`,
          `/v1/projects/${projectOf("public").id}/repo/tree?path=src`,
        ].toSorted(),
      );
      // The page reads as the code's page does, and Keel is asked nothing more.
      const source = createHttpSource(projectOf("public"));
      await source.getTree(projectOf("public").id, { path: "src/authz" });
      await source.getCommits(projectOf("public").id, { limit: 100 });
      expect(asked).toHaveLength(6);
    } finally {
      vi.unstubAllGlobals();
      readCache.clear();
    }
  });
});
