// Can-fail demonstration for the projector's ordering and duplicate checker
// (src/check.ts, the same function the Projector DO runs on every batch).
//
//   node scripts/canfail-checker.ts
//
// Builds a clean interleaved stream (50 entities, per-entity seq 1..200, entities
// interleaved at random) and runs the checker on it and on four corrupted copies.
// Exits non-zero if any case reports something other than what it expects.
import { check, newState, type Obs } from "../src/check.ts";

function clean(): Obs[] {
  const next = new Map<string, number>();
  const out: Obs[] = [];
  for (let i = 0; i < 10_000; i++) {
    const entity = `repo-${String(Math.floor(Math.random() * 50)).padStart(3, "0")}`;
    const seq = (next.get(entity) ?? 0) + 1;
    next.set(entity, seq);
    out.push({ id: `cf:${entity}:${seq}`, entity, seq });
  }
  return out;
}

const shuffle = <T>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
};

const base = clean();
const cases: { name: string; input: Obs[]; expect: (f: ReturnType<typeof check>) => boolean; want: string }[] = [
  { name: "clean", input: base, expect: (f) => f.length === 0, want: "0 findings" },
  { name: "shuffled", input: shuffle(base), expect: (f) => f.some((x) => x.kind === "regress") && f.some((x) => x.kind === "gap"), want: "regress and gap findings" },
  {
    name: "duplicated x3",
    input: [...base.slice(0, 5000), base[10]!, base[2000]!, base[4999]!, ...base.slice(5000)],
    expect: (f) => f.length === 3 && f.every((x) => x.kind === "dup"),
    want: "exactly 3 dup findings",
  },
  {
    name: "adjacent swap x1",
    input: (() => {
      // swap the first two records of one entity that are not adjacent in the stream
      const a = [...base];
      const i = a.findIndex((r) => r.seq === 5);
      const j = a.findIndex((r) => r.entity === a[i]!.entity && r.seq === 6);
      [a[i], a[j]] = [a[j]!, a[i]!];
      return a;
    })(),
    expect: (f) => f.length === 2 && f.some((x) => x.kind === "gap") && f.some((x) => x.kind === "regress"),
    want: "1 gap + 1 regress",
  },
  { name: "dropped x1", input: base.filter((_, i) => i !== 1234), expect: (f) => f.length === 1 && f[0]!.kind === "gap", want: "exactly 1 gap" },
];

let bad = 0;
for (const c of cases) {
  const st = newState(false);
  // feed in 1,000-record batches, as the projector does
  const found = [];
  for (let i = 0; i < c.input.length; i += 1000) found.push(...check(c.input.slice(i, i + 1000), st));
  const kinds = found.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  const ok = c.expect(found);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name.padEnd(17)} records=${c.input.length} findings=${JSON.stringify(kinds)} (want ${c.want})`);
}
process.exit(bad ? 1 : 0);
