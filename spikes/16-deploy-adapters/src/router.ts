// keel-spike-16-router: the isolate preview adapter.
//
//   POST   /admin/build          build a candidate in-Worker with @cloudflare/worker-bundler,
//                                store it in R2 under its content hash, return the id
//   GET    /admin/bundle/<id>    the stored worker code (main module + modules), for the REST adapter
//   DELETE /admin/cand/<id>      delete a candidate's R2 objects and this isolate's cache entry
//   GET    /admin/all            list every stored object; DELETE removes them all (teardown)
//   *      /cand/<id>/<path>     serve the candidate: assets host-side, else the Dynamic Worker
//   *      /pinned/<id>/<path>   the same, but from a Durable Object named by the id, so every
//                                request for one candidate reaches one host and one isolate
//
// Admin routes need `authorization: Bearer <ADMIN_TOKEN>` (a Worker secret).
// Candidate isolates run with globalOutbound: null and no bindings.
import { DurableObject } from "cloudflare:workers";
import { createApp, handleAssetRequest, type AssetManifest, type AssetStorage } from "@cloudflare/worker-bundler";

interface Env {
  LOADER: WorkerLoader;
  BUNDLES: R2Bucket;
  HOST: DurableObjectNamespace<CandidateHost>;
  ADMIN_TOKEN: string;
}

const CANDIDATE_COMPAT_DATE = "2026-09-01";
const ID_RE = /^[0-9a-f]{20}$/;

type StoredModule = string | { js?: string; cjs?: string; text?: string; json?: unknown };

/** What R2 holds at bundles/<id>/worker.json. Asset bodies sit beside it. */
interface StoredBundle {
  id: string;
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, StoredModule>;
  assetManifest: Array<[string, { contentType: string | undefined; etag: string }]>;
  builtAt: string;
  buildMs: number;
}

interface Loaded {
  bundle: StoredBundle;
  manifest: AssetManifest;
  /** When R2 last confirmed the bundle exists (ms epoch). */
  checkedAt: number;
}

// A cached entry older than this is re-confirmed with an R2 head before use,
// which bounds how long a deleted candidate can still be served.
const REVALIDATE_MS = 10_000;

// Per-isolate cache. Ids are content hashes, so a cached entry can never be a
// different world; it can only outlive a deletion (see DELETE /admin/cand).
const cache = new Map<string, Loaded>();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function assetText(v: string | ArrayBuffer): string {
  return typeof v === "string" ? v : new TextDecoder().decode(v);
}

function toStoredModules(modules: Record<string, unknown>): Record<string, StoredModule> {
  const out: Record<string, StoredModule> = {};
  for (const [name, mod] of Object.entries(modules)) {
    if (typeof mod === "string") out[name] = mod;
    else if (mod && typeof mod === "object" && !("data" in mod) && !("wasm" in mod)) out[name] = mod as StoredModule;
    else throw new Error(`module ${name}: binary modules are not supported by this spike`);
  }
  return out;
}

async function build(env: Env, req: Request): Promise<Response> {
  const input = (await req.json()) as {
    files: Record<string, string>;
    assets?: Record<string, string>;
    server?: string;
  };
  const t0 = Date.now();
  const result = await createApp({
    files: input.files,
    server: input.server ?? "src/index.ts",
    assets: input.assets ?? {},
  });
  const buildMs = Date.now() - t0;
  const modules = toStoredModules(result.modules);
  const assets = Object.fromEntries(Object.entries(result.assets).map(([p, v]) => [p, assetText(v)]));

  // Content address: same code + assets + compat date => same id => same
  // Dynamic Worker (one billable unique Worker per day, however many requests).
  const canonical = JSON.stringify({
    compatibilityDate: CANDIDATE_COMPAT_DATE,
    mainModule: result.mainModule,
    modules: Object.entries(modules).toSorted(([a], [b]) => a.localeCompare(b)),
    assets: Object.entries(assets).toSorted(([a], [b]) => a.localeCompare(b)),
  });
  const id = (await sha256Hex(canonical)).slice(0, 20);

  const bundle: StoredBundle = {
    id,
    compatibilityDate: CANDIDATE_COMPAT_DATE,
    mainModule: result.mainModule,
    modules,
    assetManifest: [...result.assetManifest.entries()],
    builtAt: new Date().toISOString(),
    buildMs,
  };
  const t1 = Date.now();
  await Promise.all([
    env.BUNDLES.put(`bundles/${id}/worker.json`, JSON.stringify(bundle), {
      httpMetadata: { contentType: "application/json" },
    }),
    ...Object.entries(assets).map(([p, body]) => env.BUNDLES.put(`bundles/${id}/assets${p}`, body)),
  ]);
  return json({
    id,
    buildMs,
    storeMs: Date.now() - t1,
    mainModule: result.mainModule,
    moduleBytes: Object.fromEntries(Object.entries(modules).map(([k, v]) => [k, JSON.stringify(v).length])),
    assets: Object.keys(assets),
    warnings: result.warnings ?? [],
  });
}

async function load(
  env: Env,
  id: string,
): Promise<{ loaded: Loaded | null; source: "memory" | "revalidated" | "r2" | "none"; ms: number }> {
  const t0 = Date.now();
  const hit = cache.get(id);
  if (hit && t0 - hit.checkedAt < REVALIDATE_MS) return { loaded: hit, source: "memory", ms: 0 };
  if (hit) {
    if (await env.BUNDLES.head(`bundles/${id}/worker.json`)) {
      hit.checkedAt = Date.now();
      return { loaded: hit, source: "revalidated", ms: Date.now() - t0 };
    }
    cache.delete(id);
    return { loaded: null, source: "none", ms: Date.now() - t0 };
  }
  const obj = await env.BUNDLES.get(`bundles/${id}/worker.json`);
  if (!obj) return { loaded: null, source: "none", ms: Date.now() - t0 };
  const bundle = (await obj.json()) as StoredBundle;
  const loaded = { bundle, manifest: new Map(bundle.assetManifest) as AssetManifest, checkedAt: Date.now() };
  cache.set(id, loaded);
  return { loaded, source: "r2", ms: Date.now() - t0 };
}

// handleAssetRequest trusts the manifest: if storage then returns null it
// answers 200 with an empty body. Record the miss so the caller can treat the
// candidate as gone instead.
function r2Storage(env: Env, id: string): AssetStorage & { missing: boolean } {
  const storage = {
    missing: false,
    async get(pathname: string) {
      const obj = await env.BUNDLES.get(`bundles/${id}/assets${pathname}`);
      if (!obj) storage.missing = true;
      return obj ? obj.body : null;
    },
  };
  return storage;
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

async function serveCandidate(env: Env, req: Request, id: string, rest: string): Promise<Response> {
  if (!ID_RE.test(id)) {
    return json({ error: "invalid-candidate-id", id }, 404, { "x-keel-candidate": "none" });
  }
  const { loaded, source, ms } = await load(env, id);
  if (!loaded) {
    return json({ error: "candidate-not-found", id }, 404, { "x-keel-candidate": "none" });
  }
  const url = new URL(req.url);
  url.pathname = rest === "" ? "/" : rest;
  const inner = new Request(url.toString(), req);
  const timing = `meta;desc="${source}";dur=${ms}`;

  const t0 = Date.now();
  const storage = r2Storage(env, id);
  const asset = await handleAssetRequest(inner, loaded.manifest, storage);
  if (storage.missing) {
    cache.delete(id);
    return json({ error: "candidate-not-found", id }, 404, { "x-keel-candidate": "none" });
  }
  if (asset) {
    return withHeaders(asset, {
      "x-keel-candidate": id,
      "x-keel-served-by": "asset",
      "server-timing": `${timing}, asset;dur=${Date.now() - t0}`,
    });
  }

  const { bundle } = loaded;
  const worker = env.LOADER.get(id, () => ({
    compatibilityDate: bundle.compatibilityDate,
    mainModule: bundle.mainModule,
    modules: bundle.modules as WorkerLoaderWorkerCode["modules"],
    globalOutbound: null,
  }));
  const t1 = Date.now();
  const res = await worker.getEntrypoint().fetch(inner);
  return withHeaders(res, {
    "x-keel-candidate": id,
    "x-keel-served-by": "isolate",
    "server-timing": `${timing}, isolate;dur=${Date.now() - t1}`,
  });
}

/** One per candidate id. Runs the same serve path inside the object. */
export class CandidateHost extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const m = new URL(req.url).pathname.match(/^\/pinned\/([^/]+)(\/.*)?$/);
    if (!m) return json({ error: "not-found" }, 404);
    const res = await serveCandidate(this.env, req, m[1]!, m[2] ?? "");
    return withHeaders(res, { "x-keel-host": "durable-object" });
  }
}

function authorized(env: Env, req: Request): boolean {
  const got = req.headers.get("authorization") ?? "";
  return env.ADMIN_TOKEN.length >= 32 && got === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cand = url.pathname.match(/^\/cand\/([^/]+)(\/.*)?$/);
    if (cand) return serveCandidate(env, req, cand[1]!, cand[2] ?? "");
    const pinned = url.pathname.match(/^\/pinned\/([^/]+)(\/.*)?$/);
    if (pinned) {
      if (!ID_RE.test(pinned[1]!)) return json({ error: "invalid-candidate-id", id: pinned[1] }, 404, { "x-keel-candidate": "none" });
      return env.HOST.get(env.HOST.idFromName(pinned[1]!)).fetch(req);
    }

    if (url.pathname.startsWith("/admin/")) {
      if (!authorized(env, req)) return json({ error: "unauthorized" }, 401);
      if (req.method === "POST" && url.pathname === "/admin/build") return build(env, req);
      if (url.pathname === "/admin/all" && (req.method === "GET" || req.method === "DELETE")) {
        // Every object in the bucket; DELETE removes them all (teardown of every candidate).
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.BUNDLES.list({ cursor, limit: 1000 });
          keys.push(...page.objects.map((o) => o.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        if (req.method === "DELETE") {
          for (let i = 0; i < keys.length; i += 1000) await env.BUNDLES.delete(keys.slice(i, i + 1000));
          cache.clear();
        }
        const ids = [...new Set(keys.map((k) => k.split("/")[1]))];
        return json({ method: req.method, objects: keys.length, candidates: ids.length, ids });
      }
      const m = url.pathname.match(/^\/admin\/(bundle|cand)\/([0-9a-f]{20})$/);
      if (m && m[1] === "bundle" && req.method === "GET") {
        const obj = await env.BUNDLES.get(`bundles/${m[2]}/worker.json`);
        return obj ? new Response(obj.body, { headers: { "content-type": "application/json" } }) : json({ error: "candidate-not-found" }, 404);
      }
      if (m && m[1] === "cand" && req.method === "DELETE") {
        const listed = await env.BUNDLES.list({ prefix: `bundles/${m[2]}/` });
        await Promise.all(listed.objects.map((o) => env.BUNDLES.delete(o.key)));
        cache.delete(m[2]!);
        return json({ deleted: listed.objects.map((o) => o.key) });
      }
    }
    if (url.pathname === "/") {
      return new Response("keel-spike-16-router: GET /cand/<id>/<path>\n", { headers: { "content-type": "text/plain" } });
    }
    return json({ error: "not-found" }, 404);
  },
} satisfies ExportedHandler<Env>;
