import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { InMemoryFileSystem, installDependencies } from "@cloudflare/worker-bundler";
import { buildBundle, clock, type Bundle, type BundleRequest } from "./bundle";

export interface Env {
  LOADER: WorkerLoader;
  VERIFIER: DurableObjectNamespace<VerifierDO>;
  BUNDLES: R2Bucket;
  SPIKE_TOKEN: string;
}

const COMPAT_DATE = "2026-10-01";
const CHILD_LIMITS = { cpuMs: 30_000, subRequests: 5 };

type Status = "pass" | "fail" | "skip";
interface TestResult {
  file: string;
  name: string;
  status: Status;
  error?: string;
  mode?: string;
}

interface RunOptions {
  key: string;
  n: number;
  mode: "cold" | "warm";
  concurrency: number;
  tag: string;
  keepResults?: "first" | "none";
  /** Override the child's CPU limit (used to provoke exceededCpu). */
  cpuMs?: number;
}

interface CallRecord {
  i: number;
  tag: string;
  ms: number;
  ok: boolean;
  error?: string;
  digest?: string;
  counts?: Record<Status, number>;
  /** Child isolate instance id and how many requests it had served (1 = fresh). */
  instance?: string;
  served?: number;
}

interface RunReport {
  doName: string;
  bundleSource: "memory" | "r2";
  bundleLoadMs: number;
  warmup?: CallRecord;
  calls: CallRecord[];
  distinctDigests: number;
  results?: TestResult[];
  /** Results of every run whose status digest differs from the first. */
  divergent?: Record<string, TestResult[]>;
  wallMs: number;
}

interface TailRow {
  tag: string;
  outcome: string;
  cpuMs: number;
  wallMs: number;
  exceptions: string;
  logs: string;
}

type ExportsWithTail = {
  TailCollector: (opts: { props: Record<string, unknown> }) => Fetcher;
  RegistryProxy: (opts: { props: Record<string, unknown> }) => Fetcher;
};

// ---------------------------------------------------------------------------
// Child plumbing

function childCode(
  bundle: Pick<Bundle, "mainModule" | "modules">,
  exportsObj: unknown,
  limits: workerdResourceLimits = CHILD_LIMITS,
): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: COMPAT_DATE,
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    globalOutbound: null,
    limits,
    tails: [(exportsObj as ExportsWithTail).TailCollector({ props: {} })],
  };
}

async function digestOf(results: TestResult[]): Promise<string> {
  const text = JSON.stringify(results.map((r) => [r.file, r.name, r.status]));
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function countStatuses(results: TestResult[]): Record<Status, number> {
  const c = { pass: 0, fail: 0, skip: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

async function callSuite(
  loader: WorkerLoader,
  exportsObj: unknown,
  bundle: Bundle,
  id: string,
  i: number,
  tag: string,
  limits?: workerdResourceLimits,
): Promise<{ rec: CallRecord; results?: TestResult[] }> {
  const t0 = await clock();
  try {
    const stub = loader.get(id, () => childCode(bundle, exportsObj, limits));
    const res = await stub.getEntrypoint().fetch(`https://tier1.invalid/run?tag=${encodeURIComponent(tag)}`);
    const text = await res.text();
    const ms = (await clock()) - t0;
    if (!res.ok) return { rec: { i, tag, ms, ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` } };
    const { results, instance, served } = JSON.parse(text) as { results: TestResult[]; instance?: string; served?: number };
    return {
      rec: { i, tag, ms, ok: true, digest: await digestOf(results), counts: countStatuses(results), instance, served },
      results,
    };
  } catch (e) {
    return { rec: { i, tag, ms: (await clock()) - t0, ok: false, error: errorText(e) } };
  }
}

async function pool<T>(n: number, c: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(c, n)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

const SLEEPER = {
  mainModule: "sleeper.js",
  modules: {
    "sleeper.js": `export default { async fetch(req) {
      const hold = Number(new URL(req.url).searchParams.get("hold") ?? "500");
      await new Promise((r) => setTimeout(r, hold));
      return new Response("ok");
    } };`,
  },
};

const COUNTER = {
  mainModule: "counter.js",
  modules: {
    "counter.js": `let instance;
    let served = 0;
    export default { async fetch() { instance ??= crypto.randomUUID(); served++; return Response.json({ instance, served }); } };`,
  },
};

async function counter(loader: WorkerLoader, exportsObj: unknown, id: string) {
  try {
    const res = await loader.get(id, () => childCode(COUNTER, exportsObj)).getEntrypoint().fetch("https://tier1.invalid/count");
    return (await res.json()) as { instance: string; served: number };
  } catch (e) {
    return { error: errorText(e) };
  }
}

const HOG = {
  mainModule: "hog.js",
  modules: {
    "hog.js": `export default { async fetch(req) {
      const sp = new URL(req.url).searchParams;
      const mb = Number(sp.get("mb") ?? "200");
      const hold = Number(sp.get("hold") ?? "0");
      const keep = sp.get("global") === "1" ? (globalThis.__keep ??= []) : [];
      // 1 MiB of doubles per chunk, held live until the response is built.
      for (let i = 0; i < mb; i++) keep.push(Array.from({ length: 131072 }, (_, j) => j + i + 0.5));
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      let sum = 0;
      for (const a of keep) sum += a[a.length - 1];
      return Response.json({ mb, chunks: keep.length, sum });
    } };`,
  },
};

async function limitProbe(
  loader: WorkerLoader,
  exportsObj: unknown,
  k: number,
  hold: number,
  distinct: boolean,
  tag: string,
): Promise<Array<{ i: number; ok: boolean; ms: number; error?: string }>> {
  return Promise.all(
    Array.from({ length: k }, async (_, i) => {
      const t0 = performance.now();
      try {
        const id = distinct ? `sleeper:${tag}:${i}` : `sleeper:${tag}`;
        const stub = loader.get(id, () => childCode(SLEEPER, exportsObj));
        const res = await stub.getEntrypoint().fetch(`https://tier1.invalid/sleep?hold=${hold}&tag=${tag}-${i}`);
        await res.text();
        return { i, ok: res.ok, ms: performance.now() - t0 };
      } catch (e) {
        return { i, ok: false, ms: performance.now() - t0, error: errorText(e) };
      }
    }),
  );
}

interface HogOptions {
  mb: number;
  hold: number;
  global: boolean;
  repeat: number;
}

async function hog(loader: WorkerLoader, exportsObj: unknown, o: HogOptions, tag: string) {
  const out = [];
  for (let i = 0; i < Math.max(1, o.repeat); i++) {
    const t0 = await clock();
    try {
      const stub = loader.get(`hog:${tag}`, () => childCode(HOG, exportsObj));
      const res = await stub.getEntrypoint().fetch(
        `https://tier1.invalid/hog?mb=${o.mb}&hold=${o.hold}&global=${o.global ? 1 : 0}&tag=${tag}-${i}`,
      );
      const body = (await res.text()).slice(0, 300);
      out.push({ i, ok: res.ok, status: res.status, body, ms: (await clock()) - t0 });
    } catch (e) {
      out.push({ i, ok: false, error: errorText(e), ms: (await clock()) - t0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tail: records the outcome and CPU of every child invocation.

export class TailCollector extends WorkerEntrypoint<Env> {
  override async tail(events: TraceItem[]): Promise<void> {
    const rows: TailRow[] = events.map((e) => {
      const url = (e.event as TraceItemFetchEventInfo | null)?.request?.url ?? "";
      let tag = "";
      try {
        tag = new URL(url).searchParams.get("tag") ?? "";
      } catch {
        tag = "";
      }
      return {
        tag,
        outcome: e.outcome,
        cpuMs: e.cpuTime,
        wallMs: e.wallTime,
        exceptions: e.exceptions.map((x) => `${x.name}: ${x.message}`.slice(0, 200)).join(" | "),
        logs: e.logs
          .slice(0, 10)
          .map((l) => (Array.isArray(l.message) ? l.message.map(String).join(" ") : String(l.message)).slice(0, 200))
          .join("\n"),
      };
    });
    await this.env.VERIFIER.getByName("tails").recordTails(rows);
  }
}

/** Outbound for the typecheck child when it fetches the TypeScript tarball itself. */
export class RegistryProxy extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname !== "registry.npmjs.org") return new Response("blocked", { status: 403 });
    return fetch(request);
  }
}

// ---------------------------------------------------------------------------
// Typecheck inside a child isolate

let typecheckChild: string | undefined;

interface TypecheckRequest {
  files: Record<string, string>;
  deps?: Record<string, string>;
  libs?: "r2" | "fetch";
}

async function typecheck(env: Env, exportsObj: unknown, req: TypecheckRequest) {
  const tag = `tc-${rid()}`;
  const t0 = await clock();
  typecheckChild ??= await (await env.BUNDLES.get("tc/typecheck-child.js"))!.text();
  const libs = req.libs === "fetch" ? undefined : await (await env.BUNDLES.get("tc/ts-libs.json"))!.json();
  const typeFiles: Record<string, string> = {};
  if (req.deps && Object.keys(req.deps).length) {
    const fs = new InMemoryFileSystem({ "package.json": JSON.stringify({ dependencies: req.deps }) });
    await installDependencies(fs);
    for (const p of fs.list("node_modules/")) {
      if (/\.d\.[cm]?ts$|package\.json$/.test(p)) typeFiles[p] = fs.read(p)!;
    }
  }
  const t1 = await clock();
  const ex = exportsObj as ExportsWithTail;
  try {
    const stub = env.LOADER.get(tag, () => ({
      compatibilityDate: COMPAT_DATE,
      mainModule: "tc.js",
      modules: { "tc.js": typecheckChild! },
      globalOutbound: req.libs === "fetch" ? ex.RegistryProxy({ props: {} }) : null,
      limits: CHILD_LIMITS,
      tails: [ex.TailCollector({ props: {} })],
    }));
    const res = await stub.getEntrypoint().fetch(`https://tier1.invalid/tc?tag=${tag}`, {
      method: "POST",
      body: JSON.stringify({ files: { ...typeFiles, ...req.files }, libs }),
    });
    const text = await res.text();
    const t2 = await clock();
    let result: unknown = text.slice(0, 2000);
    try {
      result = JSON.parse(text);
    } catch {
      // keep raw text
    }
    return { tag, ok: res.ok, status: res.status, prepMs: t1 - t0, childMs: t2 - t1, typeFiles: Object.keys(typeFiles).length, result };
  } catch (e) {
    return { tag, ok: false, prepMs: t1 - t0, childMs: (await clock()) - t1, error: errorText(e) };
  }
}

// ---------------------------------------------------------------------------
// Durable Object: runs suites, and (as the "tails" instance) stores tail rows.

export class VerifierDO extends DurableObject<Env> {
  private bundles = new Map<string, Bundle>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tails2 (tag TEXT, outcome TEXT, cpu_ms REAL, wall_ms REAL, exceptions TEXT, logs TEXT, at INTEGER)",
    );
  }

  recordTails(rows: TailRow[]): void {
    for (const r of rows) {
      this.ctx.storage.sql.exec(
        "INSERT INTO tails2 VALUES (?, ?, ?, ?, ?, ?, ?)",
        r.tag,
        r.outcome,
        r.cpuMs,
        r.wallMs,
        r.exceptions,
        r.logs,
        Date.now(),
      );
    }
  }

  queryTails(prefix: string): TailRow[] {
    return this.ctx.storage.sql
      .exec("SELECT tag, outcome, cpu_ms AS cpuMs, wall_ms AS wallMs, exceptions, logs FROM tails2 WHERE tag LIKE ? ORDER BY at", `${prefix}%`)
      .toArray() as unknown as TailRow[];
  }

  private async loadBundle(key: string): Promise<{ bundle: Bundle; source: "memory" | "r2"; ms: number }> {
    const cached = this.bundles.get(key);
    if (cached) return { bundle: cached, source: "memory", ms: 0 };
    const t0 = performance.now();
    const obj = await this.env.BUNDLES.get(`bundles/${key}.json`);
    if (!obj) throw new Error(`bundle ${key} not found`);
    const bundle = (await obj.json()) as Bundle;
    this.bundles.set(key, bundle);
    return { bundle, source: "r2", ms: performance.now() - t0 };
  }

  async run(doName: string, opts: RunOptions): Promise<RunReport> {
    const t0 = performance.now();
    const { bundle, source, ms } = await this.loadBundle(opts.key);
    const exportsObj = this.ctx.exports;
    const limits = opts.cpuMs ? { ...CHILD_LIMITS, cpuMs: opts.cpuMs } : CHILD_LIMITS;
    let warmup: CallRecord | undefined;
    let firstResults: TestResult[] | undefined;
    const divergent: Record<string, TestResult[]> = {};
    const seen = new Set<string>();
    const keep = (rec: CallRecord, results?: TestResult[]) => {
      if (!results || !rec.digest || seen.has(rec.digest)) return;
      seen.add(rec.digest);
      if (seen.size > 1) divergent[`${rec.digest}@${rec.i}`] = results;
    };
    const warmId = `${opts.key}:warm:${doName}:${opts.tag}`;
    if (opts.mode === "warm") {
      const w = await callSuite(this.env.LOADER, exportsObj, bundle, warmId, -1, `${opts.tag}-warmup`, limits);
      warmup = w.rec;
      firstResults = w.results;
      keep(w.rec, w.results);
    }
    const calls = await pool(opts.n, opts.concurrency, async (i) => {
      const id = opts.mode === "warm" ? warmId : `${opts.key}:cold:${doName}:${opts.tag}:${i}`;
      const r = await callSuite(this.env.LOADER, exportsObj, bundle, id, i, `${opts.tag}-${i}`, limits);
      if (!firstResults && r.results) firstResults = r.results;
      if (opts.keepResults !== "none") keep(r.rec, r.results);
      return r.rec;
    });
    const digests = new Set(calls.filter((c) => c.ok).map((c) => c.digest));
    if (warmup?.digest) digests.add(warmup.digest);
    return {
      doName,
      bundleSource: source,
      bundleLoadMs: ms,
      warmup,
      calls,
      distinctDigests: digests.size,
      results: opts.keepResults === "none" ? undefined : firstResults,
      divergent: Object.keys(divergent).length ? divergent : undefined,
      wallMs: performance.now() - t0,
    };
  }

  async limit(k: number, hold: number, distinct: boolean, tag: string) {
    return limitProbe(this.env.LOADER, this.ctx.exports, k, hold, distinct, tag);
  }

  async counter(id: string) {
    return counter(this.env.LOADER, this.ctx.exports, id);
  }

  async hog(o: HogOptions, tag: string) {
    return hog(this.env.LOADER, this.ctx.exports, o, tag);
  }
}

// ---------------------------------------------------------------------------
// HTTP surface

const round = (x: number) => Math.round(x * 10) / 10;

function summarize(xs: number[]) {
  const s = xs.toSorted((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : NaN);
  return {
    n: s.length,
    min: round(s[0] ?? NaN),
    p50: round(q(0.5)),
    p95: round(q(0.95)),
    max: round(s[s.length - 1] ?? NaN),
    mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}

function rid(): string {
  return crypto.randomUUID().slice(0, 8);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get("x-spike-token") !== env.SPIKE_TOKEN) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
    const q = (k: string, d: string) => url.searchParams.get(k) ?? d;
    try {
      switch (url.pathname) {
        case "/bundle": {
          const { bundle, report } = await buildBundle(body as unknown as BundleRequest);
          const t0 = await clock();
          await env.BUNDLES.put(`bundles/${bundle.key}.json`, JSON.stringify(bundle));
          const t1 = await clock();
          return Response.json({ ...report, r2PutMs: t1 - t0 });
        }
        case "/cached": {
          const t0 = performance.now();
          const obj = await env.BUNDLES.get(`bundles/${q("key", "")}.json`);
          const bundle = obj ? ((await obj.json()) as Bundle) : null;
          return Response.json({ found: Boolean(bundle), ms: performance.now() - t0, modules: bundle ? Object.keys(bundle.modules).length : 0 });
        }
        case "/run": {
          const doName = String(body.doName ?? "run-default");
          const opts = { tag: rid(), keepResults: "first", ...body } as RunOptions;
          const report = await env.VERIFIER.getByName(doName).run(doName, opts);
          return Response.json({ ...report, summary: summarize(report.calls.filter((c) => c.ok).map((c) => c.ms)) });
        }
        case "/fanout": {
          const m = Number(body.m ?? 10);
          const tag = String(body.tag ?? rid());
          const t0 = performance.now();
          const reports = await Promise.all(
            Array.from({ length: m }, (_, j) => {
              const doName = `fan-${tag}-${j}`;
              return env.VERIFIER.getByName(doName)
                .run(doName, { ...(body as unknown as RunOptions), tag: `${tag}-${j}`, keepResults: "none" })
                .catch((e: unknown) => ({ doName, error: errorText(e) }));
            }),
          );
          const wallMs = performance.now() - t0;
          const calls = reports.flatMap((r) => ("calls" in r ? r.calls : []));
          const digests = new Set(calls.filter((c) => c.ok).map((c) => c.digest));
          return Response.json({
            tag,
            wallMs,
            totalCalls: calls.length,
            ok: calls.filter((c) => c.ok).length,
            errors: [...new Set(calls.filter((c) => !c.ok).map((c) => c.error))].slice(0, 10),
            doErrors: reports.filter((r) => "error" in r),
            distinctDigests: digests.size,
            digests: [...digests],
            summary: summarize(calls.filter((c) => c.ok).map((c) => c.ms)),
            perDo: reports.map((r) => ("calls" in r ? { doName: r.doName, bundleLoadMs: r.bundleLoadMs, ...summarize(r.calls.filter((c) => c.ok).map((c) => c.ms)), errors: r.calls.filter((c) => !c.ok).length } : r)),
          });
        }
        case "/direct": {
          // Worker-request context (not a DO): documented limit is 4 in-flight dynamic workers.
          const tag = rid();
          const k = Number(body.k ?? 5);
          const r = await limitProbe(env.LOADER, ctx.exports, k, Number(body.hold ?? 800), body.distinct !== false, tag);
          return Response.json({ tag, k, results: r });
        }
        case "/do-limit": {
          const tag = rid();
          const k = Number(body.k ?? 11);
          const r = await env.VERIFIER.getByName(`limit-${tag}`).limit(k, Number(body.hold ?? 800), body.distinct !== false, tag);
          return Response.json({ tag, k, results: r });
        }
        case "/hog": {
          const tag = `hog-${rid()}`;
          const o: HogOptions = {
            mb: Number(body.mb ?? 200),
            hold: Number(body.hold ?? 0),
            global: body.global === true,
            repeat: Number(body.repeat ?? 1),
          };
          const r = body.where === "worker" ? await hog(env.LOADER, ctx.exports, o, tag) : await env.VERIFIER.getByName(`hog-${tag}`).hog(o, tag);
          return Response.json({ tag, ...o, calls: r });
        }
        case "/counter": {
          // Same loader id each call: does the host reach the same warm isolate?
          const id = `counter:${String(body.id)}`;
          const r = body.via === "do" ? await env.VERIFIER.getByName("counter").counter(id) : await counter(env.LOADER, ctx.exports, id);
          return Response.json(r);
        }
        case "/typecheck": {
          return Response.json(await typecheck(env, ctx.exports, body as unknown as TypecheckRequest));
        }
        case "/objects": {
          // Teardown helper: list (GET) or delete (POST {"delete":true}) every object in the bundle bucket.
          const keys: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await env.BUNDLES.list({ cursor, limit: 1000 });
            keys.push(...page.objects.map((o) => o.key));
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
          if (body.delete === true) for (let i = 0; i < keys.length; i += 1000) await env.BUNDLES.delete(keys.slice(i, i + 1000));
          return Response.json({ count: keys.length, deleted: body.delete === true, keys: keys.slice(0, 20) });
        }
        case "/tails": {
          const rows = await env.VERIFIER.getByName("tails").queryTails(q("prefix", "zzz-none"));
          return Response.json({ rows, cpu: summarize(rows.map((r) => r.cpuMs)), outcomes: rows.reduce<Record<string, number>>((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {}) });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: errorText(e), stack: e instanceof Error ? e.stack : undefined }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
