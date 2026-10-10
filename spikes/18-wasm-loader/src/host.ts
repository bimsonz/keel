// keel-spike-18-host: builds a Dynamic Worker per request from a child bundle
// ({js}) plus wasm read from R2 ({wasm}), runs it, and reports timings measured
// at the host. Also: proxies to the static tools Worker for comparison, and
// collects tail events (dynamic children via `tails`, static via tail_consumers).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import clangJs from "../build/children/clang.txt";
import compileprobeJs from "../build/children/compileprobe.txt";
import fetchprobeJs from "../build/children/fetchprobe.txt";
import hclJs from "../build/children/hcl.txt";
import memgrowJs from "../build/children/memgrow.txt";
import padJs from "../build/children/pad.txt";
import ruffJs from "../build/children/ruff.txt";
import treesitterJs from "../build/children/treesitter.txt";

interface Env {
  LOADER: WorkerLoader;
  WASM: R2Bucket;
  TOOLS: Fetcher;
  LOADER_HOST: DurableObjectNamespace<LoaderHost>;
}

const CHILD_COMPAT_DATE = "2026-09-01";

type Spec = { js: string; wasm: Record<string, string>; data?: Record<string, string> };

function spec(tool: string, q: URLSearchParams): Spec | undefined {
  switch (tool) {
    case "ruff":
      return { js: ruffJs, wasm: { "ruff.wasm": "ruff.wasm" } };
    case "clang":
      return { js: clangJs, wasm: { "clang-format.wasm": "clang-format.wasm" } };
    case "hcl":
      return { js: hclJs, wasm: { "hcl2json.wasm": "hcl2json.wasm" } };
    case "treesitter":
      return {
        js: treesitterJs,
        wasm: { "tree-sitter.wasm": "tree-sitter.wasm", "tree-sitter-typescript.wasm": "tree-sitter-typescript.wasm" },
      };
    case "pad":
      return { js: padJs, wasm: { "pad.wasm": `pad-${q.get("mb") ?? "10"}-${q.get("mode") ?? "active"}.wasm` } };
    case "memgrow":
      return { js: memgrowJs, wasm: { "memgrow.wasm": "memgrow.wasm" } };
    case "fetchprobe":
      return { js: fetchprobeJs, wasm: {} };
    case "compileprobe":
      return { js: compileprobeJs, wasm: { "tiny.wasm": "tiny.wasm" }, data: { "tiny.bin": "tiny.wasm" } };
  }
  return undefined;
}

async function readBlob(env: Env, key: string): Promise<ArrayBuffer> {
  const obj = await env.WASM.get(key);
  if (!obj) throw new Error(`R2 object missing: ${key}`);
  return obj.arrayBuffer();
}

type TailRecord = {
  url: string | null;
  outcome: string;
  cpuTime: number;
  wallTime: number;
  scriptName: string | null;
  entrypoint?: string;
  eventTimestamp: number | null;
  exceptions: Array<{ name: string; message: string }>;
  logs: string[];
};

const slim = (e: TraceItem): TailRecord => ({
  url: (e.event as TraceItemFetchEventInfo | null)?.request?.url ?? null,
  outcome: e.outcome,
  cpuTime: e.cpuTime,
  wallTime: e.wallTime,
  scriptName: e.scriptName,
  entrypoint: e.entrypoint,
  eventTimestamp: e.eventTimestamp,
  exceptions: e.exceptions.map((x) => ({ name: x.name, message: x.message })),
  logs: e.logs.slice(0, 5).map((l) => JSON.stringify(l.message).slice(0, 300)),
});

async function storeTail(env: Env, prefix: string, events: TraceItem[]) {
  const key = `tails/${prefix}/${Date.now()}-${crypto.randomUUID()}.json`;
  await env.WASM.put(key, JSON.stringify(events.map(slim)));
}

/** Tail consumer for Dynamic Worker children; props.id ties events to a run. */
export class ChildTail extends WorkerEntrypoint<Env, { id: string }> {
  async tail(events: TraceItem[]) {
    await storeTail(this.env, `child/${this.ctx.props.id}`, events);
  }
}

/** Loopback egress used only by the can-fail run of the fetch probe. */
export class Intercept extends WorkerEntrypoint<Env> {
  async fetch(req: Request) {
    return new Response(`intercepted ${new URL(req.url).hostname}`);
  }
}

const resultOf = (text: string): string => {
  try {
    return JSON.stringify((JSON.parse(text) as { result?: unknown }).result ?? null);
  } catch {
    return `raw:${text.slice(0, 100)}`;
  }
};

// repeat=N calls the same stub N-1 more times inside this request, so warm timings
// measure the warm child, not which machine an external request happened to land on.
async function repeatCalls(n: number, call: () => Promise<Response>, first: string) {
  const ms: number[] = [];
  let same = 0;
  let statusOk = 0;
  for (let i = 1; i < n; i++) {
    const t = Date.now();
    const res = await call();
    const text = await res.text();
    ms.push(Date.now() - t);
    if (res.status === 200) statusOk++;
    if (resultOf(text) === first) same++;
  }
  return { repeatMs: ms, repeatStatus200: statusOk, repeatSameResult: same };
}

async function runDynamic(req: Request, env: Env, ctx: { exports: Cloudflare.Exports }, url: URL): Promise<Response> {
  const tool = url.searchParams.get("tool") ?? "";
  const s = spec(tool, url.searchParams);
  if (!s) return new Response(`unknown tool ${tool}`, { status: 400 });
  const id = url.searchParams.get("id") ?? `${tool}-${crypto.randomUUID()}`;
  const cpuMs = Number(url.searchParams.get("cpuMs") ?? "10000");
  const egress = url.searchParams.get("egress") ?? "null"; // "null" | "intercept"
  const input = req.method === "POST" ? await req.text() : "";

  let cold = false;
  let r2Ms = 0;
  let r2Bytes = 0;
  const t0 = Date.now();
  try {
    const stub = env.LOADER.get(id, async () => {
      cold = true;
      const a = Date.now();
      const modules: Record<string, WorkerLoaderModule> = { "child.js": { js: s.js } };
      for (const [name, key] of Object.entries(s.wasm)) {
        const buf = await readBlob(env, key);
        r2Bytes += buf.byteLength;
        modules[name] = { wasm: buf };
      }
      for (const [name, key] of Object.entries(s.data ?? {})) {
        const buf = await readBlob(env, key);
        r2Bytes += buf.byteLength;
        modules[name] = { data: buf };
      }
      r2Ms = Date.now() - a;
      return {
        compatibilityDate: CHILD_COMPAT_DATE,
        mainModule: "child.js",
        modules,
        globalOutbound: egress === "intercept" ? ctx.exports.Intercept({}) : null,
        limits: { cpuMs },
        tails: [ctx.exports.ChildTail({ props: { id } })],
      };
    });
    const callChild = () =>
      stub.getEntrypoint().fetch(`https://child/${tool}${url.search}`, { method: "POST", body: input });
    const res = await callChild();
    const text = await res.text();
    const totalMs = Date.now() - t0;
    let child: unknown = text;
    try {
      child = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const repeat = Number(url.searchParams.get("repeat") ?? "1");
    const repeats = repeat > 1 ? await repeatCalls(repeat, callChild, resultOf(text)) : {};
    return Response.json({
      tool,
      id,
      cold,
      r2Ms,
      r2Bytes,
      totalMs,
      loadAndRunMs: totalMs - r2Ms,
      status: res.status,
      ...repeats,
      child,
    });
  } catch (e) {
    const err = e as Error;
    return Response.json(
      {
        tool,
        id,
        cold,
        r2Ms,
        r2Bytes,
        totalMs: Date.now() - t0,
        status: 0,
        hostError: `${err?.name}: ${err?.message ?? String(e)}`,
      },
      { status: 502 },
    );
  }
}

async function runStatic(req: Request, env: Env, url: URL): Promise<Response> {
  const tool = url.searchParams.get("tool") ?? "";
  const input = req.method === "POST" ? await req.text() : "";
  const t0 = Date.now();
  const callTools = () => env.TOOLS.fetch(`https://tools/${tool}${url.search}`, { method: "POST", body: input });
  const res = await callTools();
  const text = await res.text();
  const totalMs = Date.now() - t0;
  let child: unknown = text;
  try {
    child = JSON.parse(text);
  } catch {
    // keep raw text
  }
  const repeat = Number(url.searchParams.get("repeat") ?? "1");
  const repeats = repeat > 1 ? await repeatCalls(repeat, callTools, resultOf(text)) : {};
  return Response.json({ tool, totalMs, status: res.status, ...repeats, child });
}

/** One named instance pins loads to one machine, so same-id reuse can actually hit. */
export class LoaderHost extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    return runDynamic(req, this.env, this.ctx, new URL(req.url));
  }
}

async function listTails(env: Env, prefix: string): Promise<Response> {
  const listed = await env.WASM.list({ prefix: `tails/${prefix}` });
  const out: Array<{ key: string; events: TailRecord[] }> = [];
  for (const o of listed.objects) {
    const body = await env.WASM.get(o.key);
    if (body) out.push({ key: o.key, events: JSON.parse(await body.text()) as TailRecord[] });
  }
  return Response.json(out);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/run":
        return runDynamic(req, env, ctx, url);
      case "/do-run":
        return env.LOADER_HOST.get(env.LOADER_HOST.idFromName(url.searchParams.get("do") ?? "primary")).fetch(req);
      case "/static":
        return runStatic(req, env, url);
      case "/tails":
        return listTails(env, url.searchParams.get("prefix") ?? "");
      case "/purge-tails": {
        let n = 0;
        for (;;) {
          const listed = await env.WASM.list({ prefix: "tails/" });
          if (!listed.objects.length) break;
          await env.WASM.delete(listed.objects.map((o) => o.key));
          n += listed.objects.length;
        }
        return Response.json({ deleted: n });
      }
    }
    return new Response("keel-spike-18-host\n", { status: 404 });
  },
  // tail_consumers target for the static tools Worker.
  async tail(events, env): Promise<void> {
    await storeTail(env, "static", events);
  },
} satisfies ExportedHandler<Env>;
