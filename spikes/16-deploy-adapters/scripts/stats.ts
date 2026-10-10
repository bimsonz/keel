// Reads scripts/ttfb.sh lines on stdin and prints ms stats for TTFB and for
// TTFB minus TLS-established (server share + one round trip).
//
//   scripts/ttfb.sh <url> 20 | node scripts/stats.ts <label> [--max-ms N]
//
// With --max-ms, exits 1 when any TTFB sample is at or above N (or any
// response is not 2xx/3xx/404).
import { readFileSync } from "node:fs";

const label = process.argv[2] ?? "sample";
const maxIdx = process.argv.indexOf("--max-ms");
const maxMs = maxIdx >= 0 ? Number(process.argv[maxIdx + 1]) : undefined;

const rows = readFileSync(0, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split(" "))
  .map(([code, , app, start]) => ({ code: Number(code), ttfb: Number(start) * 1000, server: (Number(start) - Number(app)) * 1000 }));

const pct = (xs: number[], p: number) => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const r = (x: number) => Math.round(x);
const ttfb = rows.map((x) => x.ttfb);
const server = rows.map((x) => x.server);
const codes = [...new Set(rows.map((x) => x.code))].join(",");
const out = {
  label,
  n: rows.length,
  codes,
  ttfbMs: { min: r(Math.min(...ttfb)), p50: r(pct(ttfb, 50)), p95: r(pct(ttfb, 95)), max: r(Math.max(...ttfb)) },
  afterTlsMs: { p50: r(pct(server, 50)), p95: r(pct(server, 95)) },
  samplesMs: ttfb.map(r),
};
console.log(JSON.stringify(out));
if (maxMs !== undefined) {
  const bad = rows.filter((x) => x.ttfb >= maxMs || !(x.code < 400 || x.code === 404));
  if (bad.length > 0) {
    console.error(`FAIL ${label}: ${bad.length}/${rows.length} samples at or over ${maxMs} ms or bad status`);
    process.exit(1);
  }
}
