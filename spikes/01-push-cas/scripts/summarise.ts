// Summarise race TSVs: outcome counts, how each trial was decided, loser error
// texts and push latency percentiles.  node scripts/summarise.ts results/*.tsv
import { readFileSync } from "node:fs";

const pct = (xs: number[], p: number): number => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
const norm = (s: string | undefined): string =>
  (s ?? "").replace(/[0-9a-f]{12,40}/g, "<sha>").replace(/HEAD -> \S+/, "HEAD -> main");
const count = (xs: string[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

for (const file of process.argv.slice(2)) {
  const [head, ...rows] = readFileSync(file, "utf8").trimEnd().split("\n");
  const cols = head.split("\t");
  const recs = rows.map((r) => Object.fromEntries(r.split("\t").map((v, i) => [cols[i], v])));
  const outcomes = count(recs.map((r) => r.outcome));
  const violations = recs.filter((r) => r.outcome.startsWith("VIOLATION")).length;
  const ms = recs.flatMap((r) => [Number(r.msA), Number(r.msB)]);
  console.log(`## ${file.split("/").pop()}  (${recs.length} trials)`);
  console.log(`outcomes: ${JSON.stringify(outcomes)}`);
  console.log(`CAS violations: ${violations}`);
  if (cols.includes("decided")) console.log(`decided: ${JSON.stringify(count(recs.map((r) => r.decided)))}`);
  const loserText = recs.map((r) =>
    r.outcome === "A_WON" ? r.errB ?? r.resB : r.outcome === "B_WON" ? r.errA ?? r.resA : `(${r.outcome})`,
  );
  console.log(`loser text: ${JSON.stringify(count(loserText.map(norm)), null, 1)}`);
  console.log(`push ms p50/p95/max: ${pct(ms, 50)} / ${pct(ms, 95)} / ${Math.max(...ms)}`);
  console.log(`start skew ms max: ${Math.max(...recs.map((r) => Number(r.skew_ms)))}`);
  console.log();
}
