// Gradual-rollout checks against a deployed forge-lite Worker.
//
//   node scripts/split.ts sample <url> <n> <expectedPctA> [--override <header-value>]
//     Classifies n requests (10 in flight) and checks the share of world A
//     against the expectation: |observed - expected| <= 3 sigma (binomial).
//     Exit 1 when it does not hold. --override sends
//     Cloudflare-Workers-Version-Overrides with the given value.
//
//   node scripts/split.ts wait <url> <base|A> <consecutive> <timeoutSec>
//     Polls until <consecutive> classifications in a row are the target world
//     and prints how long that took. Exit 1 on timeout.
import { classify, type World } from "./world.ts";

const [cmd, url, ...rest] = process.argv.slice(2);
if (!url) {
  console.error("usage: see header");
  process.exit(2);
}

if (cmd === "sample") {
  const n = Number(rest[0]);
  const expectedPct = Number(rest[1]);
  const oi = rest.indexOf("--override");
  const headers: Record<string, string> = oi >= 0 ? { "Cloudflare-Workers-Version-Overrides": rest[oi + 1]! } : {};
  const counts: Record<World, number> = { base: 0, A: 0, unknown: 0 };
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (next < n) {
        next++;
        counts[(await classify(url, headers)).world]++;
      }
    }),
  );
  const p = expectedPct / 100;
  const expected = n * p;
  const sigma = Math.sqrt(n * p * (1 - p));
  const tolerance = Math.max(3 * sigma, 1);
  const ok = counts.unknown === 0 && Math.abs(counts.A - expected) <= tolerance;
  console.log(
    JSON.stringify({
      n,
      counts,
      observedPctA: Math.round((counts.A / n) * 1000) / 10,
      expectedPctA: expectedPct,
      toleranceCount: Math.round(tolerance * 10) / 10,
      override: headers["Cloudflare-Workers-Version-Overrides"] ?? null,
      ms: Math.round(performance.now() - t0),
      verdict: ok ? "ok" : "MISMATCH",
    }),
  );
  process.exit(ok ? 0 : 1);
}

if (cmd === "wait") {
  const target = rest[0] as World;
  const need = Number(rest[1]);
  const timeoutMs = Number(rest[2]) * 1000;
  const t0 = performance.now();
  let streak = 0;
  let polls = 0;
  const seen: Record<World, number> = { base: 0, A: 0, unknown: 0 };
  while (performance.now() - t0 < timeoutMs) {
    const { world } = await classify(url);
    polls++;
    seen[world]++;
    streak = world === target ? streak + 1 : 0;
    if (streak >= need) {
      // Time to the first of the `need` consecutive hits is the honest figure;
      // report both.
      console.log(JSON.stringify({ target, polls, seen, msToStreakEnd: Math.round(performance.now() - t0), verdict: "ok" }));
      process.exit(0);
    }
  }
  console.log(JSON.stringify({ target, polls, seen, verdict: "TIMEOUT" }));
  process.exit(1);
}
if (cmd === "settle") {
  // node scripts/split.ts settle <url> <base|A> <batch> <cleanBatches> <timeoutSec>
  // Batches of <batch> classifications (10 in flight). Settled when
  // <cleanBatches> batches in a row are 100% the target world. Reports the
  // time from start to the first clean batch of that run, and the trace of
  // %target per batch with its offset in ms.
  const target = rest[0] as World;
  const batch = Number(rest[1]);
  const needClean = Number(rest[2]);
  const timeoutMs = Number(rest[3]) * 1000;
  const t0 = performance.now();
  const trace: string[] = [];
  let clean = 0;
  let cleanStart = 0;
  while (performance.now() - t0 < timeoutMs) {
    const at = Math.round(performance.now() - t0);
    let hits = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        while (next < batch) {
          next++;
          if ((await classify(url)).world === target) hits++;
        }
      }),
    );
    trace.push(`${at}:${Math.round((hits / batch) * 100)}`);
    if (hits === batch) {
      if (clean === 0) cleanStart = at;
      clean++;
      if (clean >= needClean) {
        console.log(JSON.stringify({ target, settledAtMs: cleanStart, samples: trace.length * batch, trace: trace.join(" "), verdict: "ok" }));
        process.exit(0);
      }
    } else clean = 0;
  }
  console.log(JSON.stringify({ target, samples: trace.length * batch, trace: trace.join(" "), verdict: "TIMEOUT" }));
  process.exit(1);
}

console.error(`unknown command ${cmd}`);
process.exit(2);
