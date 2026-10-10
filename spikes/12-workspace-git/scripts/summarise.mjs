// Join results/<label>.jsonl with wrangler tail events (CPU, wall, outcome)
// and print p50/p95 per phase.  node scripts/summarise.mjs <tail.json[,tail2.json]> <label>...
import { readFileSync } from "node:fs";

function parseConcatenatedJson(txt) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0) objs.push(JSON.parse(txt.slice(start, i + 1))); }
  }
  return objs;
}

// Nearest-rank percentile.
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};

const [tailFile, ...labels] = process.argv.slice(2);
const tail = new Map();
for (const ev of tailFile.split(",").flatMap((f) => parseConcatenatedJson(readFileSync(f, "utf8")))) {
  const u = ev.event?.request?.url;
  if (!u) continue;
  const q = new URL(u).searchParams;
  if (q.get("run")) tail.set(`${q.get("run")}#${q.get("i")}`, ev);
}

for (const label of labels) {
  const rows = readFileSync(new URL(`../results/${label}.jsonl`, import.meta.url), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const ok = rows.filter((r) => r.body.ok);
  const joined = rows.map((r) => ({ r, ev: tail.get(`${label}#${r.i}`) }));
  const missing = joined.filter((j) => !j.ev).length;
  const cols = {
    clone: ok.map((r) => r.body.t.clone),
    commit: ok.map((r) => r.body.t.commit),
    push: ok.map((r) => r.body.t.push),
    "cycle (clone+commit+push)": ok.map((r) => r.body.cycleMs),
    "fork/get": ok.map((r) => r.body.t.fork),
    token: ok.map((r) => r.body.t.token),
    verify: ok.map((r) => r.body.t.verify ?? 0),
    "request wall (tail)": joined.filter((j) => j.ev && j.r.body.ok).map((j) => j.ev.wallTime),
    "request CPU (tail)": joined.filter((j) => j.ev && j.r.body.ok).map((j) => j.ev.cpuTime),
  };
  const outcomes = {};
  for (const j of joined) { const o = j.ev?.outcome ?? "no-tail-event"; outcomes[o] = (outcomes[o] ?? 0) + 1; }
  const verified = ok.filter((r) => r.body.verified === true).length;
  const peak = Math.max(0, ...ok.map((r) => r.body.memfs?.peakBytes ?? 0));
  console.log(`\n== ${label}: n=${rows.length} ok=${ok.length} verified=${verified} tail-joined=${rows.length - missing} outcomes=${JSON.stringify(outcomes)} memfs-peak=${peak}B`);
  console.log("metric".padEnd(28), "p50".padStart(7), "p95".padStart(7), "max".padStart(7), "  n");
  for (const [k, xs] of Object.entries(cols)) {
    if (!xs.length) continue;
    console.log(k.padEnd(28), String(pct(xs, 50)).padStart(7), String(pct(xs, 95)).padStart(7), String(Math.max(...xs)).padStart(7), " ", xs.length);
  }
  const ops = {};
  for (const r of ok) for (const h of r.body.http ?? []) (ops[h.op] ??= []).push(h.totalMs);
  for (const [op, xs] of Object.entries(ops)) {
    console.log(`  http ${op}`.padEnd(28), String(pct(xs, 50)).padStart(7), String(pct(xs, 95)).padStart(7), String(Math.max(...xs)).padStart(7), " ", xs.length);
  }
  const warm = ok.flatMap((r) => r.body.warm ?? []).map((w) => w.commit + w.push);
  if (warm.length) {
    console.log("warm commit+push (no clone)".padEnd(28), String(pct(warm, 50)).padStart(7), String(pct(warm, 95)).padStart(7), String(Math.max(...warm)).padStart(7), " ", warm.length);
    const perCycleCpu = joined.filter((j) => j.ev && j.r.body.ok).map((j) => Math.round(j.ev.cpuTime / j.r.body.n));
    console.log("CPU per cycle (req CPU / n)".padEnd(28), String(pct(perCycleCpu, 50)).padStart(7), String(pct(perCycleCpu, 95)).padStart(7), String(Math.max(...perCycleCpu)).padStart(7), " ", perCycleCpu.length);
  }
  const cyc = cols["cycle (clone+commit+push)"], cpu = cols["request CPU (tail)"];
  if (cyc.length) console.log(`pass(<2000ms wall p95): ${pct(cyc, 95) < 2000}  pass(<500ms CPU p95): ${cpu.length ? pct(cpu, 95) < 500 : "untested"}`);
  const fails = rows.filter((r) => !r.body.ok);
  for (const f of fails) console.log(`  fail #${f.i} http=${f.http} phase=${f.body.phase} ${JSON.stringify(f.body.error)}`);
}
