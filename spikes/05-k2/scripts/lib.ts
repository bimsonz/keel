// Shared driver helpers. SPIKE_HOST and SPIKE_KEY come from the environment and are
// never written to the repo.
import { writeFileSync } from "node:fs";

export async function call<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T; ms: number; headers: Headers }> {
  const host = process.env.SPIKE_HOST;
  const key = process.env.SPIKE_KEY;
  if (!host || !key) throw new Error("set SPIKE_HOST and SPIKE_KEY");
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const r = await fetch(`https://${host}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "x-spike-key": key, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    const ms = performance.now() - t0;
    // A freshly put secret reaches isolates gradually; retry the 403 a few times.
    if (r.status === 403 && attempt < 10) {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: r.status, body: body as T, ms, headers: r.headers };
  }
}

export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
export const results = new URL("../results/", import.meta.url);
// Stream, subscription and batch IDs (32 hex chars) are replaced by stable aliases
// (<id1>, <id2>, ...) so a saved result still shows which IDs are equal.
const aliases = new Map<string, string>();
export const redact = (text: string) =>
  text.replace(/[0-9a-f]{32}/g, (m) => {
    if (!aliases.has(m)) aliases.set(m, `<id${aliases.size + 1}>`);
    return aliases.get(m)!;
  });
export const save = (name: string, v: unknown) => writeFileSync(new URL(name, results), redact(JSON.stringify(v, null, 1)) + "\n");

export function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : dflt;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}
