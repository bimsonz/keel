// Match local pushes (results/pushes.jsonl) to Workflow instances started by the
// namespace trigger (results/events.json, fetched from the Worker's /events).
//
//   node scripts/match.ts [--phases fresh,spread,burst] [--drop <n>] [--dup <n>] [--prefix r]
//
// --drop n  removes the instances matching the first n pushes before matching
//           (simulated loss): the matcher must report exactly n misses.
// --dup n   injects a copy of n instances: the matcher must report n duplicates.
// Latency is instance start (Worker clock) minus local push completion, corrected
// by the Worker-minus-local clock offset in results/clock-start.json.
import { readFileSync } from "node:fs";

type Push = { seq: number; phase: string; repo: string; ref: string; before: string; after: string; localDone: number; ok: boolean };
type Inst = { instance_id: string; started_at: number; wf_ts: number; repo: string; ref: string; before: string; after: string };

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const phases = new Set((opt("phases") ?? "fresh,spread,burst").split(","));
const prefix = opt("prefix") ?? "r";
const drop = Number(opt("drop") ?? 0);
const dup = Number(opt("dup") ?? 0);
const res = new URL("../results/", import.meta.url);

const offset = (JSON.parse(readFileSync(new URL("clock-start.json", res), "utf8")) as { best: { offset: number } }).best.offset;
const pushes = readFileSync(new URL("pushes.jsonl", res), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Push)
  .filter((p) => phases.has(p.phase) && p.repo.startsWith(prefix) && p.ok);
let inst = (JSON.parse(readFileSync(new URL("events.json", res), "utf8")) as { instances: Inst[] }).instances.filter((i) =>
  i.repo?.startsWith(prefix),
);

const key = (r: string, ref: string, after: string) => `${r}|${ref}|${after}`;
if (drop) {
  const victims = new Set(pushes.slice(0, drop).map((p) => key(p.repo, p.ref, p.after)));
  inst = inst.filter((i) => !victims.has(key(i.repo, i.ref, i.after)));
}
if (dup) inst = [...inst, ...inst.slice(0, dup).map((i) => ({ ...i, instance_id: `${i.instance_id}-dup` }))];

const byKey = new Map<string, Inst[]>();
for (const i of inst) {
  const k = key(i.repo, i.ref, i.after);
  byKey.set(k, [...(byKey.get(k) ?? []), i]);
}
const pushKeys = new Set(pushes.map((p) => key(p.repo, p.ref, p.after)));

const missed: Push[] = [];
const dups: { push: number; instances: number }[] = [];
const lat: Record<string, number[]> = { all: [] };
const created: number[] = [];
for (const p of pushes) {
  const m = byKey.get(key(p.repo, p.ref, p.after));
  if (!m?.length) {
    missed.push(p);
    continue;
  }
  if (m.length > 1) dups.push({ push: p.seq, instances: m.length });
  const first = m.toSorted((a, b) => a.started_at - b.started_at)[0];
  const l = first.started_at - offset - p.localDone;
  lat.all.push(l);
  (lat[p.phase] ??= []).push(l);
  created.push(first.wf_ts - offset - p.localDone);
}
const extra = inst.filter((i) => !pushKeys.has(key(i.repo, i.ref, i.after)));

const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)];
};
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: pct(xs, 100), min: pct(xs, 0) });

console.log(
  JSON.stringify(
    {
      phases: [...phases],
      clockOffsetMs: offset,
      pushes: pushes.length,
      repos: new Set(pushes.map((p) => p.repo)).size,
      instances: inst.length,
      matched: pushes.length - missed.length,
      missed: missed.length,
      missedPushes: missed.slice(0, 10).map((p) => ({ seq: p.seq, phase: p.phase, repo: p.repo, after: p.after.slice(0, 10) })),
      duplicates: dups.length,
      duplicateDetail: dups.slice(0, 10),
      unmatchedInstances: extra.length,
      latencyPushDoneToInstanceStartMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stats(v)])),
      latencyPushDoneToInstanceCreatedMs: stats(created),
    },
    null,
    1,
  ),
);
