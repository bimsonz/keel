// Drive the forker Worker: N forks of one source, `conc` requests in flight at once
// (client-side fan-out: one fork per request, the way one change = one request).
//
//   WORKER_URL=... SPIKE_KEY_FILE=... node scripts/run-forks.ts <run> <src> <n> <conc> [poll=150] [del=1] [extra query]
//
// Appends one JSON line per fork to results/<run>.jsonl and prints a summary.
import { appendFileSync, readFileSync } from "node:fs";

const [run, src, nArg, concArg, pollArg = "150", delArg = "1", extra = ""] = process.argv.slice(2);
if (!run || !src || !nArg || !concArg) throw new Error("usage: run src n conc [poll] [del] [extra]");
const url = process.env.WORKER_URL;
const keyFile = process.env.SPIKE_KEY_FILE;
if (!url || !keyFile) throw new Error("WORKER_URL and SPIKE_KEY_FILE required");
const key = readFileSync(keyFile, "utf8").trim();
const n = Number(nArg);
const conc = Number(concArg);
const out = new URL(`../results/${run}.jsonl`, import.meta.url);
const tag = `${run.replace(/[^a-z0-9]/gi, "").slice(0, 16)}${Date.now().toString(36).slice(-4)}`;

type Row = Record<string, unknown> & { readyMs?: number | null; forkReturnedMs?: number | null; t0?: number };

async function one(i: number): Promise<Row> {
  const name = `${tag}-${i}`;
  const q = new URLSearchParams({ src, name, poll: pollArg, del: delArg });
  const qs = `${q.toString()}${extra ? `&${extra}` : ""}`;
  const clientStart = Date.now();
  const res = await fetch(`${url}/fork?${qs}`, { method: "POST", headers: { "x-spike-key": key } });
  const clientMs = Date.now() - clientStart;
  const placement = res.headers.get("cf-placement");
  let body: Row;
  try {
    body = (await res.json()) as Row;
  } catch {
    body = { parseError: true };
  }
  const row: Row = { run, i, status: res.status, clientStart, clientMs, placement, ...body };
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  return row;
}

const rows: Row[] = [];
let next = 0;
const t = Date.now();
await Promise.all(
  Array.from({ length: Math.min(conc, n) }, async () => {
    while (next < n) {
      const i = next++;
      rows.push(await one(i));
    }
  }),
);
const wall = Date.now() - t;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const ready = rows.map((r) => r.readyMs).filter((x): x is number => typeof x === "number");
const forkRet = rows.map((r) => r.forkReturnedMs).filter((x): x is number => typeof x === "number");
const t0s = rows.map((r) => r.t0).filter((x): x is number => typeof x === "number");
const readyAbs = rows
  .filter((r) => typeof r.t0 === "number" && typeof r.readyMs === "number")
  .map((r) => (r.t0 as number) + (r.readyMs as number));
const errors = rows.filter((r) => r.status !== 200 || r.forkError || r.readyMs == null);
const reasons: Record<string, number> = {};
for (const r of rows) for (const [k, v] of Object.entries((r.reasons as Record<string, number>) ?? {})) reasons[k] = (reasons[k] ?? 0) + v;
const firstAttempt: Record<string, number> = {};
for (const r of rows) {
  const k = (r.firstAttempt as { reason?: string } | null)?.reason ?? "none";
  firstAttempt[k] = (firstAttempt[k] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      run,
      src,
      n,
      conc,
      ok: rows.length - errors.length,
      errors: errors.map((e) => ({ i: e.i, status: e.status, forkError: e.forkError, error: e.error })),
      colo: [...new Set(rows.map((r) => r.colo))],
      placement: [...new Set(rows.map((r) => r.placement))],
      forkCall: { p50: pct(forkRet, 50), p95: pct(forkRet, 95), max: pct(forkRet, 100) },
      ready: { p50: pct(ready, 50), p95: pct(ready, 95), max: pct(ready, 100) },
      spanFirstForkToLastReadyMs: t0s.length && readyAbs.length ? Math.max(...readyAbs) - Math.min(...t0s) : null,
      startSpreadMs: t0s.length ? Math.max(...t0s) - Math.min(...t0s) : null,
      clientWallMs: wall,
      reasons,
      firstAttempt,
      readyBeforeForkReturned: rows.filter((r) => r.readyBeforeForkReturned === true).length,
      deleted: rows.filter((r) => (r.del as { deleted?: boolean } | null)?.deleted === true).length,
    },
    null,
    1,
  ),
);
