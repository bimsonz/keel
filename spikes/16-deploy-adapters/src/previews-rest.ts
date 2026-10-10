// Workers Previews REST adapter. Uses only fetch, FormData and Blob, so the
// same code runs in a Worker (token from a Secrets Store binding) and in Node
// (token from the environment). Endpoints and payloads are the ones wrangler
// 4.149.0 sends for `wrangler preview` (deploy-helpers/src/preview/api.ts).
//
//   GET    /accounts/{acct}/workers/workers/{worker}/previews/{name|id}
//   POST   /accounts/{acct}/workers/workers/{worker}/previews                 {"name": ...}
//   POST   /accounts/{acct}/workers/workers/{worker}/previews/{id}/deployments multipart:
//            metadata = {"main_module", "compatibility_date", "compatibility_flags"?, "env"?,
//                        "assets"? {"jwt","config"}, "annotations"?, "limits"?, ...}
//            files    = one part per module, filename = module name, type = module MIME
//   GET    /accounts/{acct}/workers/workers/{worker}/previews/{id}/deployments/latest
//   DELETE /accounts/{acct}/workers/workers/{worker}/previews/{name|id}
//   GET    /accounts/{acct}/workers/workers/{worker}/previews?page=N&per_page=M   (list; not wrapped by wrangler)

export interface PreviewsClient {
  accountId: string;
  token: string;
  apiBase?: string;
}

/** Module shapes as @cloudflare/worker-bundler returns them. */
export type BundledModule = string | { js?: string; cjs?: string; text?: string; json?: unknown };

export interface PreviewResource {
  id: string;
  name: string;
  slug: string;
  urls?: string[];
}

export interface PreviewDeployment {
  id: string;
  number: number;
  urls?: string[];
  annotations?: Record<string, string>;
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
}

export class PreviewsApiError extends Error {
  readonly status: number;
  readonly codes: number[];
  constructor(status: number, codes: number[], message: string) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

async function call<T>(c: PreviewsClient, path: string, init: RequestInit = {}): Promise<T> {
  const base = c.apiBase ?? "https://api.cloudflare.com/client/v4";
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${c.token}`);
  const res = await fetch(`${base}/accounts/${c.accountId}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !body?.success) {
    const errors = body?.errors ?? [];
    throw new PreviewsApiError(
      res.status,
      errors.map((e) => e.code),
      `${init.method ?? "GET"} ${path}: HTTP ${res.status} ${errors.map((e) => `[${e.code}] ${e.message}`).join("; ")}`,
    );
  }
  return body.result;
}

const enc = encodeURIComponent;

export async function getPreview(c: PreviewsClient, worker: string, nameOrId: string): Promise<PreviewResource | null> {
  try {
    return await call<PreviewResource>(c, `/workers/workers/${worker}/previews/${enc(nameOrId)}`);
  } catch (e) {
    // wrangler treats 10025 as "no such preview".
    if (e instanceof PreviewsApiError && (e.status === 404 || e.codes.includes(10025))) return null;
    throw e;
  }
}

export async function upsertPreview(c: PreviewsClient, worker: string, name: string): Promise<{ preview: PreviewResource; created: boolean }> {
  const existing = await getPreview(c, worker, name);
  if (existing) return { preview: existing, created: false };
  const preview = await call<PreviewResource>(c, `/workers/workers/${worker}/previews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return { preview, created: true };
}

function modulePart(name: string, mod: BundledModule): { content: string; type: string } {
  if (typeof mod === "string") return { content: mod, type: "application/javascript+module" };
  if (mod.js !== undefined) return { content: mod.js, type: "application/javascript+module" };
  if (mod.cjs !== undefined) return { content: mod.cjs, type: "application/javascript" };
  if (mod.text !== undefined) return { content: mod.text, type: "text/plain" };
  if (mod.json !== undefined) return { content: JSON.stringify(mod.json), type: "application/json" };
  throw new Error(`module ${name}: unsupported shape`);
}

export async function createPreviewDeployment(
  c: PreviewsClient,
  worker: string,
  previewId: string,
  code: { mainModule: string; modules: Record<string, BundledModule>; compatibilityDate: string; annotations?: Record<string, string> },
): Promise<PreviewDeployment> {
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: code.mainModule,
      compatibility_date: code.compatibilityDate,
      ...(code.annotations ? { annotations: code.annotations } : {}),
    }),
  );
  for (const [name, mod] of Object.entries(code.modules)) {
    const { content, type } = modulePart(name, mod);
    form.append("files", new Blob([content], { type }), name);
  }
  return call<PreviewDeployment>(c, `/workers/workers/${worker}/previews/${enc(previewId)}/deployments`, {
    method: "POST",
    body: form,
  });
}

export async function listPreviews(c: PreviewsClient, worker: string): Promise<PreviewResource[]> {
  const all: PreviewResource[] = [];
  for (let page = 1; ; page++) {
    const batch = await call<PreviewResource[]>(c, `/workers/workers/${worker}/previews?page=${page}&per_page=50`);
    all.push(...batch);
    if (batch.length < 50) return all;
  }
}

export async function deletePreview(c: PreviewsClient, worker: string, nameOrId: string): Promise<void> {
  await call<unknown>(c, `/workers/workers/${worker}/previews/${enc(nameOrId)}`, { method: "DELETE" });
}
