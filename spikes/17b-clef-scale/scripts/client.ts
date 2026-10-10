// Client for the spike Worker. The Worker URL and bearer token come from the
// environment (S17B_URL, S17B_TOKEN) and are never written to disk.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MODELS = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
} as const;
export type ModelName = keyof typeof MODELS;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface ClefOutput {
  model: string;
  answers: Record<string, ChoiceAnswer | { type: "noul"; noul: number }>;
  usage: { input_tokens: number; output_tokens: number };
}
export interface RunResult {
  status: number;
  ok: boolean;
  ms: number | null; // binding call time measured inside the Worker
  clientMs: number;
  output?: ClefOutput;
  error?: Record<string, unknown>;
  bodyText?: string;
}

const url = process.env.S17B_URL;
const token = process.env.S17B_TOKEN;

export async function run(endpoint: string, input: unknown): Promise<RunResult> {
  if (!url || !token) throw new Error("S17B_URL and S17B_TOKEN must be set");
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ endpoint, input }),
  });
  const text = await res.text();
  const clientMs = performance.now() - t0;
  try {
    const body = JSON.parse(text) as { ok: boolean; ms: number; output?: ClefOutput; error?: Record<string, unknown> };
    return { status: res.status, ok: body.ok, ms: body.ms, clientMs, output: body.output, error: body.error };
  } catch {
    return { status: res.status, ok: false, ms: null, clientMs, bodyText: text.slice(0, 500) };
  }
}

export function isRateLimited(r: RunResult): boolean {
  const s = JSON.stringify(r.error ?? r.bodyText ?? "");
  return r.status === 429 || /429|rate.?limit|too many|capacity/i.test(s);
}

/** Sequential-per-slot runner with a global minimum spacing between call starts. */
export async function runPaced<T>(
  tasks: (() => Promise<T>)[],
  opts: { concurrency: number; minSpacingMs: number },
): Promise<T[]> {
  const out: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let lastStart = 0;
  async function slot(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      const wait = lastStart + opts.minSpacingMs - Date.now();
      lastStart = Math.max(Date.now(), lastStart + opts.minSpacingMs);
      if (wait > 0) await sleep(wait);
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, slot));
  return out;
}

/** Retry on rate limiting with backoff; counts retries so they can be reported. */
export async function runWithRetry(endpoint: string, input: unknown, maxRetries = 4): Promise<RunResult & { retries: number }> {
  let retries = 0;
  for (;;) {
    const r = await run(endpoint, input);
    if (!isRateLimited(r) || retries >= maxRetries) return { ...r, retries };
    retries++;
    await sleep(2000 * retries);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS = join(here, "..", "results");
export function save(name: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, name), JSON.stringify(data, null, 2) + "\n");
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = xs.toSorted((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
