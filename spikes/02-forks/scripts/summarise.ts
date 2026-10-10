// Summarise every results/<run>.jsonl written by run-forks.ts into one table.
//   node scripts/summarise.ts [run ...]
// Serialisation check: sort the forks of a run by absolute ready time; if forks
// were serialised, ready time would grow by about one single-fork time per rank
// (slope ~ single-fork p50). If parallel, the slope is near 0.
import { readdirSync, readFileSync } from "node:fs";

type Row = {
  status: number;
  colo?: string;
  placement?: string | null;
  t0?: number;
  forkReturnedMs?: number | null;
  readyMs?: number | null;
  forkError?: string | null;
  reasons?: Record<string, number>;
  firstAttempt?: { reason: string } | null;
  del?: { deleted?: boolean; deleteMs?: number } | null;
};

const dir = new URL("../results/", import.meta.url);
const runs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));

const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)];
};

function slope(ys: number[]): number | null {
  if (ys.length < 3) return null;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return Math.round(num / den);
}

console.log("| run | n | ok | colo / placement | fork() p50 / p95 / max | ready p50 / p95 / max | span first fork→last ready | slope ms/rank | delete p50 | non-ready reasons seen |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const run of runs) {
  const rows = readFileSync(new URL(`${run}.jsonl`, dir), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
  const ok = rows.filter((r) => r.status === 200 && !r.forkError && typeof r.readyMs === "number");
  const fork = ok.map((r) => r.forkReturnedMs as number);
  const ready = ok.map((r) => r.readyMs as number);
  const del = rows.map((r) => r.del?.deleteMs).filter((x): x is number => typeof x === "number");
  const t0 = Math.min(...ok.map((r) => r.t0 as number));
  const abs = ok.map((r) => (r.t0 as number) + (r.readyMs as number) - t0).toSorted((a, b) => a - b);
  const reasons: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.reasons ?? {})) if (k !== "READY") reasons[k] = (reasons[k] ?? 0) + v;
  const errs = rows.filter((r) => !ok.includes(r)).map((r) => r.forkError ?? `http ${r.status}`);
  const where = `${[...new Set(rows.map((r) => r.colo))].join(",")} / ${[...new Set(rows.map((r) => r.placement ?? "default"))].join(",")}`;
  console.log(
    `| ${run} | ${rows.length} | ${ok.length}${errs.length ? ` (${[...new Set(errs)].join(", ")})` : ""} | ${where} | ${pct(fork, 50)} / ${pct(fork, 95)} / ${pct(fork, 100)} | ${pct(ready, 50)} / ${pct(ready, 95)} / ${pct(ready, 100)} | ${abs.at(-1)} | ${slope(abs)} | ${pct(del, 50)} | ${Object.entries(reasons)
      .map(([k, v]) => `${k}×${v}`)
      .join(", ")} |`,
  );
}
