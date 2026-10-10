import { DurableObject } from "cloudflare:workers";
import { admit, vacuity, type WorldEvaluation } from "./admission.ts";
import { bundleProbe } from "./bundle.ts";
import { clock } from "./clock.ts";
import type { ModelSettings } from "./draft.ts";
import { draftLoop, type Evaluation } from "./loop.ts";
import { harness, readRun, type RunResult } from "./outcome.ts";
import { SYSTEM, userPrompt, type DraftInput } from "./prompt.ts";

export interface Env {
  AI: Ai;
  LOADER: WorkerLoader;
  VERIFIER: DurableObjectNamespace<VerifierDO>;
  SPIKE_TOKEN: string;
}

const COMPAT_DATE = "2026-10-01";
const CHILD_LIMITS = { cpuMs: 30_000, subRequests: 5 };
const RUN_TIMEOUT_MS = 30_000;
const RUN_CONCURRENCY = 4;

export interface RunRecord extends RunResult {
  ms: number;
  id: string;
  testError?: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
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

async function runChild(
  loader: WorkerLoader,
  bundle: { mainModule: string; modules: Record<string, string> },
  id: string,
): Promise<RunRecord> {
  const t0 = await clock();
  const done = async (r: RunResult, testError?: string): Promise<RunRecord> => ({
    ...r,
    ms: (await clock()) - t0,
    id,
    ...(testError ? { testError: testError.slice(0, 300) } : {}),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A fresh id per run: a warm isolate would carry module state between runs (S14).
    const stub = loader.get(id, () => ({
      compatibilityDate: COMPAT_DATE,
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      globalOutbound: null,
      limits: CHILD_LIMITS,
    }));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${RUN_TIMEOUT_MS} ms`)), RUN_TIMEOUT_MS);
    });
    const res = await Promise.race([stub.getEntrypoint().fetch("https://probe.invalid/run"), timeout]);
    const text = await res.text();
    if (!res.ok) return done(harness(`missing JSON line: the runner answered HTTP ${res.status}: ${text.slice(0, 300)}`));
    let body: { exit?: number; stdout?: string; tests?: Array<{ error?: string }> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return done(harness(`missing JSON line: the runner's answer is not readable: ${text.slice(0, 300)}`));
    }
    return done(readRun(body.stdout, body.exit), body.tests?.[0]?.error);
  } catch (e) {
    return done(harness(`missing JSON line: the runner did not answer: ${errorText(e)}`));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------

export class VerifierDO extends DurableObject<Env> {
  private worlds?: Record<string, Record<string, string>>;

  // Registry role (the "registry" instance): worlds and the drafting input.
  async putSetup(worlds: Record<string, Record<string, string>>, input: DraftInput): Promise<{ worlds: string[] }> {
    for (const [name, files] of Object.entries(worlds)) await this.ctx.storage.put(`world:${name}`, files);
    await this.ctx.storage.put("input", input);
    return { worlds: Object.keys(worlds) };
  }

  async getWorlds(): Promise<Record<string, Record<string, string>>> {
    const m = await this.ctx.storage.list<Record<string, string>>({ prefix: "world:" });
    return Object.fromEntries([...m].map(([k, v]) => [k.slice("world:".length), v]));
  }

  async getInput(): Promise<DraftInput> {
    const input = await this.ctx.storage.get<DraftInput>("input");
    if (!input) throw new Error("no drafting input: POST /setup first");
    return input;
  }

  // Evaluator role (one instance per job): bundle per world, run each on fresh isolates.
  async evaluate(probe: string, worldNames: string[], runs: number, tag: string): Promise<Evaluation> {
    const t0 = await clock();
    this.worlds ??= await this.env.VERIFIER.getByName("registry").getWorlds();
    const bundleMs: Record<string, number> = {};
    const bundles = new Map<string, { mainModule: string; modules: Record<string, string> }>();
    const evals: WorldEvaluation[] = [];
    let bytes: number | undefined;
    for (const world of worldNames) {
      const files = this.worlds[world];
      if (!files) throw new Error(`unknown world ${world}`);
      const b0 = await clock();
      const b = await bundleProbe(files, probe);
      bundleMs[world] = (await clock()) - b0;
      if (b.bundle) {
        bundles.set(world, b.bundle);
        bytes ??= b.bundle.bytes;
        evals.push({ world, runs: [] });
      } else {
        evals.push({ world, bundleError: b.error ?? "unknown bundle error", runs: [] });
      }
    }
    const jobs = evals.filter((e) => bundles.has(e.world)).flatMap((e) => Array.from({ length: runs }, (_, i) => ({ e, i })));
    const results = await pool(jobs.length, RUN_CONCURRENCY, async (j) => {
      const { e, i } = jobs[j]!;
      return runChild(this.env.LOADER, bundles.get(e.world)!, `${tag}:${e.world}:${i}:${crypto.randomUUID()}`);
    });
    jobs.forEach(({ e }, j) => e.runs.push(results[j]!));
    return { evals, bundleMs, ...(bytes ? { bytes } : {}), wallMs: (await clock()) - t0 };
  }
}

// ---------------------------------------------------------------------------

function streamJob(ctx: ExecutionContext, job: (progress: (o: unknown) => void) => Promise<unknown>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = (o: unknown) => void writer.write(enc.encode(`${JSON.stringify(o)}\n`)).catch(() => undefined);
  const hb = setInterval(() => write({ hb: Date.now() }), 10_000);
  ctx.waitUntil(
    (async () => {
      try {
        write({ result: await job(write) });
      } catch (e) {
        write({ error: errorText(e), stack: e instanceof Error ? e.stack : undefined });
      } finally {
        clearInterval(hb);
        await writer.close().catch(() => undefined);
      }
    })(),
  );
  return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
}

function evaluator(env: Env, tag: string) {
  const stub = env.VERIFIER.getByName(`eval-${tag}`);
  let k = 0;
  return (probe: string, worlds: string[], runs: number) => stub.evaluate(probe, worlds, runs, `${tag}-${k++}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get("x-spike-token") !== env.SPIKE_TOKEN) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
    const registry = env.VERIFIER.getByName("registry");
    try {
      switch (url.pathname) {
        case "/setup":
          return Response.json(
            await registry.putSetup(body.worlds as Record<string, Record<string, string>>, body.input as DraftInput),
          );
        case "/prompt": {
          const input = await registry.getInput();
          const user = userPrompt(input, url.searchParams.get("mode") === "template" ? "template" : "probe");
          return Response.json({ system: SYSTEM, user, chars: SYSTEM.length + user.length });
        }
        case "/evaluate": {
          // Evaluate a given probe over the matrix plus mutant A (the can-fail demonstrations).
          const tag = String(body.tag ?? crypto.randomUUID().slice(0, 8));
          const worlds = (body.worlds as string[] | undefined) ?? ["base", "A", "B", "AB", "mutantA"];
          const runs = Number(body.runs ?? 3);
          const evaluate = evaluator(env, tag);
          return streamJob(ctx, async () => {
            const ev = await evaluate(String(body.probe), worlds, runs);
            return {
              tag,
              ...ev,
              admission: admit(ev.evals),
              vacuity: vacuity(ev.evals.find((e) => e.world === "mutantA")),
            };
          });
        }
        case "/draft": {
          const settings = body.settings as ModelSettings;
          if (!settings?.model?.startsWith("@cf/")) return new Response("settings.model must be an exact @cf/ catalogue id", { status: 400 });
          const tag = String(body.tag ?? crypto.randomUUID().slice(0, 8));
          const input = await registry.getInput();
          return streamJob(ctx, (progress) =>
            draftLoop(env.AI, settings, input, evaluator(env, tag), progress, Number(body.maxRepairs ?? 3), body.mode === "template" ? "template" : "probe"),
          );
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: errorText(e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
